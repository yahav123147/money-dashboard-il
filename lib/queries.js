// Shared read-side queries for the dashboard API routes (Task 4).
// Mirrors the Task 1 classifier's P&L definition exactly:
// operating profit = revenue + refunds - expenses, where expenses =
// -(sum of bucket_group IN ('expense','unclassified') over ILS CHECKING rows)
// + -(non-below_line CARD rows, USD converted at (settings.usdToIls || 1)).
// any CARD row with bucket_group='below_line' (personal/charity/other-venture) is excluded; internal group excluded.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../scripts/lib/db.mjs';
import { tokens, tokenMatch } from '../scripts/lib/classify.mjs';
import { CATEGORY_LABELS, BELOW_LINE_SUBS } from '../scripts/lib/expenses.mjs';
import { loadTaxRules, recognitionFor } from '../scripts/lib/tax-rules.mjs';
import { estimateTax } from '../scripts/lib/tax-engines.mjs';
import { reconcile, isSettlementCredit, DEFAULT_SETTLEMENT } from '../scripts/lib/reconcile.mjs';
import { detectRecurring, normalizeName } from '../scripts/lib/recurring-detect.mjs';


// The annualised income-tax figure for an entity, from a PERIOD's taxable
// income. Brackets are annual, the dashboard's period is partial-year — so
// annualise, tax, and scale back. opts flow from settings unless a test
// overrides them.
function periodIncomeTax(entityType, periodTaxable, monthsInPeriod, creditPoints) {
  if (monthsInPeriod <= 0) return { periodTax: 0, estimate: null };
  const annual = (periodTaxable / monthsInPeriod) * 12;
  const est = estimateTax(entityType || 'company', annual, taxBrackets, { creditPoints });
  return { periodTax: est.incomeTax * (monthsInPeriod / 12), estimate: est };
}

const ROOT = process.cwd();
const DB_PATH = process.env.MONEY_DB_PATH || join(ROOT, 'data', 'money.db');

// settings re-reads the settings file whenever it changes, so the
// in-app setup wizard (and a hand edit) take effect without a server restart.
// Every `settings.x` read goes through the proxy; the file is parsed only when
// its mtime moved.
function liveJson(path) {
  let cache = null;
  let seen = -1;
  const load = () => {
    const mtime = statSync(path).mtimeMs;
    if (mtime !== seen) { cache = JSON.parse(readFileSync(path, 'utf8')); seen = mtime; }
    return cache;
  };
  return new Proxy({}, {
    get: (_, k) => load()[k],
    has: (_, k) => k in load(),
    ownKeys: () => Reflect.ownKeys(load()),
    getOwnPropertyDescriptor: (_, k) => ({ value: load()[k], enumerable: true, configurable: true }),
  });
}
export const settings = liveJson(join(ROOT, 'config', 'settings.json'));
export const recurring = liveJson(join(ROOT, 'config', 'recurring.json'));

const taxBrackets = JSON.parse(
  readFileSync(join(ROOT, 'config', 'tax-brackets.json'), 'utf8'),
);

// Singleton connection (survives dev-server HMR).
export function getDb() {
  if (!globalThis.__moneyDb) globalThis.__moneyDb = openDb(DB_PATH);
  return globalThis.__moneyDb;
}

// Israel calendar day as YYYY-MM-DD (the machine may run in any timezone).
export function israelToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
}

// YYYY-MM-DD string offset by n days.
export function shiftDate(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// First month of the tax year a given YYYY-MM falls in. The Israeli tax year
// is the calendar year, so every year-to-date window has to be derived from
// the month being looked at, never written as a literal. A literal '2026-01'
// keeps working all through 2026 and then quietly empties the P&L, the
// expense breakdown and the tax bridge on 1 January 2027.
export function taxYearStart(ym) {
  return `${ym.slice(0, 4)}-01`;
}

function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function daysBetween(fromIso, toIso) {
  return Math.round(
    (new Date(toIso + 'T00:00:00Z') - new Date(fromIso + 'T00:00:00Z')) / 86400000,
  );
}

const r = (v) => Math.round(v);

export const REVENUE_BUCKETS = ['direct', 'other_revenue'];
export const EXPENSE_BUCKETS = [
  'team', 'cards', 'tax_advance', 'tax_withholding', 'tax_vat', 'tax_social',
  'rent', 'pension', 'suppliers_other', 'unclassified',
];

// Monthly P&L. Returns { months: [...], avg3m } with months sorted ascending.
export function computePnl(db) {
  const currentMonth = israelToday().slice(0, 7);
  const rows = db.prepare(`
    SELECT month, bucket, bucket_group, currency, account_type, SUM(amount) AS total
    FROM bank_transactions
    WHERE month IS NOT NULL
      AND ((account_type='CHECKING' AND currency='ILS'
            AND bucket_group IN ('revenue','refund','expense','unclassified'))
        OR (account_type='CARD' AND bucket_group != 'below_line'))
    GROUP BY month, bucket, bucket_group, currency, account_type
  `).all();

  const byMonth = new Map();
  const monthEntry = (m) => {
    if (!byMonth.has(m)) {
      byMonth.set(m, {
        month: m,
        revenue_gross: 0,
        revenue_ex_vat: 0,
        refunds: 0,
        revenue_breakdown: Object.fromEntries(REVENUE_BUCKETS.map((b) => [b, 0])),
        expenses: Object.fromEntries(EXPENSE_BUCKETS.map((b) => [b, 0])),
        operating_profit: 0,
        partial: m === currentMonth,
      });
    }
    return byMonth.get(m);
  };

  for (const row of rows) {
    const e = monthEntry(row.month);
    if (row.account_type === 'CARD') {
      const ils = row.currency === 'USD' ? row.total * (settings.usdToIls || 1) : row.total;
      e.expenses.cards += -ils;
    } else if (row.bucket_group === 'revenue') {
      e.revenue_gross += row.total;
      if (row.bucket in e.revenue_breakdown) e.revenue_breakdown[row.bucket] += row.total;
    } else if (row.bucket_group === 'refund') {
      e.refunds += row.total;
    } else {
      // expense + unclassified: stored negative, expose as positive cost
      e.expenses[row.bucket] += -row.total;
    }
  }

  // Bound to the current month, exactly as the month rail does. The bank
  // reports PENDING rows days ahead (standing orders, card settlements), and a
  // future-dated row would otherwise create a phantom month that `partial`
  // marks complete — poisoning avg3m and becoming the last entry that
  // "this month" consumers read.
  const months = [...byMonth.values()]
    .filter((m) => m.month <= currentMonth)
    .sort((a, b) => a.month.localeCompare(b.month));
  for (const e of months) {
    const totalExpenses = Object.values(e.expenses).reduce((s, v) => s + v, 0);
    e.operating_profit = r(e.revenue_gross + e.refunds - totalExpenses);
    e.revenue_ex_vat = r(e.revenue_gross / settings.vatRate);
    e.revenue_gross = r(e.revenue_gross);
    e.refunds = r(e.refunds);
    for (const k of Object.keys(e.revenue_breakdown)) e.revenue_breakdown[k] = r(e.revenue_breakdown[k]);
    for (const k of Object.keys(e.expenses)) e.expenses[k] = r(e.expenses[k]);
  }

  const complete = months.filter((m) => !m.partial);
  const last3 = complete.slice(-3);
  const avg3m = last3.length
    ? r(last3.reduce((s, m) => s + m.operating_profit, 0) / last3.length)
    : 0;

  return { months, avg3m };
}

const NON_CARD_LABELS = {
  team: 'צוות ומנטורים',
  tax_vat: 'מע"מ',
  tax_advance: 'מקדמות מס',
  tax_withholding: 'ניכויים',
  tax_social: 'ביטוח לאומי',
  rent: 'שכירות',
  pension: 'פנסיה',
  suppliers_other: 'ספקים אחר',
  unclassified: 'לא מסווג',
};

export function computeExpenses(db) {
  const today = israelToday();
  const currentMonth = today.slice(0, 7);
  const FROM = taxYearStart(currentMonth);
  const ils = (amount, currency) => (currency === 'USD' ? amount * (settings.usdToIls || 1) : amount);

  const byMonth = new Map();
  const entry = (m) => {
    if (!byMonth.has(m)) {
      byMonth.set(m, {
        month: m,
        partial: m === currentMonth,
        byCategory: {},
        belowLine: { personal: 0, charity: 0, other_venture: 0 },
        belowLineTotal: 0,
        total: 0,
        _vendors: new Map(),
      });
    }
    return byMonth.get(m);
  };

  // card rows: sub_bucket categories + vendor tally (FX-converted)
  const cardRows = db.prepare(`
    SELECT month, amount, currency, counterparty, sub_bucket, bucket_group
    FROM bank_transactions
    WHERE account_type='CARD' AND month IS NOT NULL AND month >= '${FROM}'
  `).all();
  for (const row of cardRows) {
    if (row.month > currentMonth) continue;
    const e = entry(row.month);
    const cost = -ils(row.amount, row.currency);   // spend is negative -> positive cost
    const sub = row.sub_bucket || 'other_business';
    if (BELOW_LINE_SUBS.includes(sub)) {
      e.belowLine[sub] += cost;
      e.belowLineTotal += cost;
    } else {
      e.byCategory[sub] = (e.byCategory[sub] || 0) + cost;
      e.total += cost;
    }
    const name = (row.counterparty || '(ללא שם)').trim();
    const v = e._vendors.get(name) || { name, category: sub, amount: 0, count: 0 };
    v.amount += cost;
    v.count += 1;
    e._vendors.set(name, v);
  }

  // non-card expense buckets (ILS checking) complete the picture
  const bankRows = db.prepare(`
    SELECT month, bucket, SUM(amount) AS total FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS'
      AND bucket_group IN ('expense','unclassified')
      AND month IS NOT NULL AND month >= '${FROM}'
    GROUP BY month, bucket
  `).all();
  for (const row of bankRows) {
    if (row.month > currentMonth) continue;
    const e = entry(row.month);
    const cost = -row.total;
    e.byCategory[row.bucket] = (e.byCategory[row.bucket] || 0) + cost;
    e.total += cost;
  }

  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  for (const m of months) {
    m.topVendors = [...m._vendors.values()]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10)
      .map((v) => ({ ...v, amount: r(v.amount) }));
    delete m._vendors;
    for (const k of Object.keys(m.byCategory)) m.byCategory[k] = r(m.byCategory[k]);
    for (const k of Object.keys(m.belowLine)) m.belowLine[k] = r(m.belowLine[k]);
    m.belowLineTotal = r(m.belowLineTotal);
    m.total = r(m.total);
  }

  return { months, labels: { ...CATEGORY_LABELS, ...NON_CARD_LABELS } };
}

// Tax-advance status for a given Israel month. `month` defaults to the
// current one, but is a parameter so the dashboard's month picker can ask
// "was the March advance enough?" without a second endpoint.
export function computeAdvances(db, month = israelToday().slice(0, 7), opts = {}) {
  const entityType = opts.entityType ?? settings.entityType ?? null;
  const creditPoints = opts.creditPoints ?? settings.creditPoints ?? null;
  const today = israelToday();
  const priorMonth = shiftDate(month + '-01', -1).slice(0, 7);

  const priorRevenue = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS'
      AND bucket_group='revenue' AND month=?
  `).get(priorMonth).s;

  const turnoverExVat = r(priorRevenue / settings.vatRate);
  const ratePct = settings.advanceRatePct;
  const targetAmount = r(turnoverExVat * ratePct / 100);

  const paid = r(-db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS'
      AND bucket='tax_advance' AND month=? AND amount < 0
  `).get(month).s);

  const deadline = `${month}-15`;
  const daysLeft = daysBetween(today, deadline);
  const paidPct = targetAmount > 0 ? Math.min(100, r((paid / targetAmount) * 100)) : (paid > 0 ? 100 : 0);

  let status = 'pending';
  if (paid > 0 && (targetAmount === 0 || paid >= targetAmount * 0.95)) status = 'paid';
  else if (daysLeft < 0) status = 'late';

  // dynamic required advance rate: corporate tax on actual YTD profit vs turnover.
  // Single source of truth: computePnl. Never re-derive profit here.
  // Bounded to <= month so a past month picked from the dashboard is judged
  // against the profit known AT that point, not months that had not happened yet.
  const fullMonths = computePnl(db).months
    .filter((m) => !m.partial && m.month >= taxYearStart(month) && m.month <= month);
  const ytdProfit = fullMonths.reduce((s, m) => s + m.operating_profit, 0);
  const ytdTurnover = fullMonths.reduce((s, m) => s + m.revenue_ex_vat, 0);
  let requiredRatePct = null;
  let annualGapIls = null;
  if (fullMonths.length > 0 && ytdTurnover > 0) {
    const { periodTax } = periodIncomeTax(entityType, ytdProfit, fullMonths.length, creditPoints);
    requiredRatePct = Math.max(0, Math.round((periodTax / ytdTurnover) * 1000) / 10);
    annualGapIls = r(((requiredRatePct - settings.advanceRatePct) / 100)
      * ytdTurnover * (12 / fullMonths.length));
  }

  return { month, turnoverExVat, ratePct, targetAmount, paid, paidPct, deadline, daysLeft, status, requiredRatePct, annualGapIls };
}

// Anomaly flags for /api/overview. Ordered most severe first.
export function computeFlags(db, opts = {}) {
  const entityType = opts.entityType ?? settings.entityType ?? null;
  const today = israelToday();
  const d7 = shiftDate(today, -7);
  const d14 = shiftDate(today, -14);
  const flags = [];

  // 0. עוסק פטור: the turnover ceiling is statutory — crossing it by one shekel
  //    ends the patur status and makes the excess liable for VAT. This is the
  //    single most important thing the board can tell a patur, so it comes first.
  if (entityType === 'patur') {
    const cap = taxBrackets.osekPatur?.annualTurnoverCeiling;
    const yearStart = today.slice(0, 4) + '-01';
    const ytdTurnover = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) s FROM bank_transactions
      WHERE account_type='CHECKING' AND currency='ILS' AND amount > 0
        AND bucket_group='revenue' AND month >= ?
    `).get(yearStart).s;
    if (cap > 0 && ytdTurnover > 0) {
      const pct = Math.round((ytdTurnover / cap) * 100);
      if (pct >= 100) {
        flags.push({
          type: 'patur_ceiling', severity: 'high',
          text: `חרגת מתקרת עוסק פטור: מחזור ${r(ytdTurnover).toLocaleString('he-IL')} שח מול תקרה של ${cap.toLocaleString('he-IL')} שח (${pct}%). העודף חייב במע"מ — דבר עם רו"ח בהקדם`,
          date: null, amount: r(ytdTurnover - cap),
        });
      } else if (pct >= 80) {
        flags.push({
          type: 'patur_ceiling', severity: 'medium',
          text: `מתקרב לתקרת עוסק פטור: ${pct}% מהתקרה (${r(ytdTurnover).toLocaleString('he-IL')} מתוך ${cap.toLocaleString('he-IL')} שח). חריגה של שקל אחד מחייבת מע"מ על העודף`,
          date: null, amount: r(cap - ytdTurnover),
        });
      }
    }
  }

  // 0b. CardCom sales whose bank settlement never arrived. Money that is
  //     owed to the business and did not land is the one thing nothing else
  //     on the board can see, so it sits right under the patur ceiling.
  try {
    const rec = computeReconcile(db, 45);
    if (rec.enabled && rec.summary?.missing > 0) {
      const miss = rec.rows.filter((x) => x.status === 'missing');
      const span = miss.length === 1 ? miss[0].label : `${miss[miss.length - 1].label} עד ${miss[0].label}`;
      flags.push({
        type: 'settlement_missing', severity: 'high',
        text: `כסף שנסלק בקארדקום לא הגיע לבנק: מכירות ${span}, ${r(rec.summary.missingAmount).toLocaleString('he-IL')} שח שהיו צפויים בחשבון ולא נמצאו. לבדוק מול חברת הסליקה`,
        date: miss[0].windowTo, amount: r(rec.summary.missingAmount),
      });
    }
  } catch { /* reconciliation is optional; never block the other flags */ }

  // 0c. Forecast bottoms out below the owner's comfort line.
  try {
    const cf = computeCashflow(db, today, 30);
    if (cf.dip && cf.dip.belowWarn) {
      flags.push({
        type: 'cash_dip', severity: cf.dip.projected < 0 ? 'high' : 'medium',
        text: `תזרים: היתרה החזויה יורדת ל-${r(cf.dip.projected).toLocaleString('he-IL')} שח ב-${cf.dip.date}${cf.dip.nextInflow ? `, ההכנסה הבאה (${r(cf.dip.nextInflow.amount).toLocaleString('he-IL')} שח) רק ב-${cf.dip.nextInflow.date}` : ', בלי הכנסה צפויה אחריה'}`,
        date: cf.dip.date, amount: r(cf.dip.projected),
      });
    }
  } catch { /* optional */ }

  // 1. Advance unpaid and the month is at day >= 13.
  const dayOfMonth = Number(today.slice(8, 10));
  if (dayOfMonth >= 13) {
    const adv = computeAdvances(db);
    if (adv.status !== 'paid' && adv.targetAmount > 0) {
      flags.push({
        type: 'advance', severity: 'high',
        text: `מקדמת מס הכנסה לחודש ${adv.month} עוד לא שולמה (יעד ${adv.targetAmount.toLocaleString('he-IL')} שח עד ${adv.deadline})`,
        date: adv.deadline, amount: adv.targetAmount,
      });
    }
  }

  // 2. Unclassified rows (the classifier could not bucket them).
  const unclassified = db.prepare(`
    SELECT date, amount, counterparty FROM bank_transactions
    WHERE bucket='unclassified' ORDER BY date DESC
  `).all();
  for (const t of unclassified) {
    flags.push({
      type: 'unclassified', severity: 'medium',
      text: `תנועה לא מסווגת: ${t.counterparty}`,
      date: t.date, amount: r(t.amount),
    });
  }

  // 3. Large movements in the last 7 days (internal rows and already-flagged
  //    unclassified rows excluded).
  //    The threshold is defaulted here on purpose: an undefined bind is not an
  //    error in SQLite, it is NULL, and `ABS(amount) >= NULL` is never true.
  //    A missing settings key would therefore switch this alert off forever
  //    instead of failing loudly. It did exactly that once.
  const flagThreshold = Number(settings.flagThresholdIls);
  const big = db.prepare(`
    SELECT date, amount, counterparty, bucket FROM bank_transactions
    WHERE date >= ? AND ABS(amount) >= ?
      AND bucket_group != 'internal' AND bucket != 'unclassified'
    ORDER BY ABS(amount) DESC
  `).all(d7, Number.isFinite(flagThreshold) ? flagThreshold : 5000);
  for (const t of big) {
    flags.push({
      type: 'large_amount', severity: 'medium',
      text: `תנועה גדולה: ${t.counterparty} (${t.bucket})`,
      date: t.date, amount: r(t.amount),
    });
  }

  // 4. Refunds in the last 14 days.
  const refunds = db.prepare(`
    SELECT date, amount, counterparty, bucket FROM bank_transactions
    WHERE bucket_group='refund' AND date >= ? ORDER BY date DESC
  `).all(d14);
  for (const t of refunds) {
    flags.push({
      type: 'refund', severity: 'medium',
      text: `החזר כספי: ${t.counterparty}`,
      date: t.date, amount: r(t.amount),
    });
  }


  // 8. Failed import run (spec: "ייבוא דוח שנכשל") — newest payment_import row not ok
  const lastPayRun = db.prepare(`
    SELECT ok, ts, note FROM sync_log WHERE source='payment_import' ORDER BY id DESC LIMIT 1
  `).get();
  if (lastPayRun && !lastPayRun.ok) {
    flags.push({
      type: 'sync', severity: 'medium',
      date: lastPayRun.ts ? lastPayRun.ts.slice(0, 10) : null, amount: null,
    });
  }

  // 9. Sync health: last financy_refresh failed or skipped.
  const lastRefresh = db.prepare(`
    SELECT ts, ok, note FROM sync_log WHERE source='financy_refresh'
    ORDER BY id DESC LIMIT 1
  `).get();
  if (lastRefresh && (!lastRefresh.ok || /skip/i.test(lastRefresh.note || ''))) {
    flags.push({
      type: 'sync', severity: 'medium',
      text: `רענון נתוני בנק אחרון נכשל או דולג (${lastRefresh.note || 'ללא פירוט'})`,
      date: lastRefresh.ts ? lastRefresh.ts.slice(0, 10) : null, amount: null,
    });
  }

  // 6. New counterparties first seen in the last 7 days.
  const newCps = db.prepare(`
    SELECT name, first_seen FROM counterparties
    WHERE first_seen >= ? ORDER BY first_seen DESC
  `).all(d7);
  for (const c of newCps) {
    flags.push({
      type: 'new_counterparty', severity: 'low',
      text: `גורם חדש בחשבון: ${c.name}`,
      date: c.first_seen, amount: null,
    });
  }

  return flags;
}

function parseRaw(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

// Card debt accrued since the last settlement, in ILS. The accounts row keeps a
// single primary leg (ILS), but a card can also carry foreign-currency debt —
// raw_json.balances holds every leg. Same currency rule as liquidTotal: ILS and
// USD only, others excluded rather than added at face value.
function cardChargeIls(a, raw, rate) {
  const legs = (raw?.balances || []).filter(
    (b) => b.balanceType === 'interimBooked' && !b.creditLimitIncluded,
  );
  if (legs.length === 0) {
    return Math.abs(a.balance || 0) * (a.currency === 'USD' ? rate : 1);
  }
  let total = 0;
  for (const b of legs) {
    const amount = Math.abs(Number(b.balanceAmount?.amount) || 0);
    if (b.balanceAmount?.currency === 'ILS') total += amount;
    else if (b.balanceAmount?.currency === 'USD') total += amount * rate;
  }
  return total;
}

// Everything /api/overview needs.
export function computeOverview(db) {
  const today = israelToday();
  const rate = (settings.usdToIls || 1);

  const accounts = db.prepare(`SELECT * FROM accounts ORDER BY type, number`).all();
  const balances = accounts.map((a) => ({
    name: a.name || a.number || a.id,
    type: a.type,
    currency: a.currency,
    balance: a.balance == null ? null : Math.round(a.balance * 100) / 100,
    asOf: a.balance_date || (a.updated_at ? a.updated_at.slice(0, 10) : null),
  }));

  let liquidTotal = 0;
  let creditAvailable = 0;
  let creditBlocked = 0;
  let upcomingCardCharge = 0;
  for (const a of accounts) {
    const bal = a.balance || 0;
    if (a.type === 'CHECKING') {
      // Plan definition: ILS checking + USD at (settings.usdToIls || 1); other
      // currencies (e.g. EUR) are excluded rather than added at face value.
      if (a.currency === 'ILS') liquidTotal += bal;
      else if (a.currency === 'USD') liquidTotal += bal * rate;
    }
    if (a.securities_value) liquidTotal += a.securities_value;
    if (a.type === 'CARD') {
      const raw = parseRaw(a.raw_json);
      // Debt is owed whatever the card's status — a blocked card still settles.
      upcomingCardCharge += cardChargeIls(a, raw, rate);
      if (a.credit_limit) {
        // Financy keeps reporting a limit for blocked and cancelled cards, but
        // only an enabled card's frame can actually be spent. Cards synced
        // before status was captured have no raw_json — treat those as enabled.
        const status = raw?.status;
        const unused = Math.max(0, a.credit_limit - Math.abs(bal));
        if (!status || status === 'enabled') creditAvailable += unused;
        else if (status === 'blocked') creditBlocked += unused;
      }
    }
  }

  // 30-day balance trend from snapshots (checking accounts; unknown ids included).
  const trend = db.prepare(`
    SELECT s.snap_date AS date,
      SUM(s.balance * CASE WHEN s.currency='USD' THEN ? ELSE 1 END) AS total
    FROM balance_snapshots s
    LEFT JOIN accounts a ON a.id = s.account_id
    WHERE (a.type IS NULL OR a.type='CHECKING') AND s.snap_date >= ?
    GROUP BY s.snap_date ORDER BY s.snap_date
  `).all(rate, shiftDate(today, -30))
    .map((t) => ({ date: t.date, total: r(t.total) }));

  // sync_log.ts comes from SQLite datetime('now') which is UTC; mark it as such
  // so the browser does not parse it as local time.
  const utcIso = (ts) => (ts ? ts.replace(' ', 'T') + 'Z' : ts);

  const lastFinancy = utcIso(db.prepare(`
    SELECT MAX(ts) AS ts FROM sync_log WHERE source LIKE 'financy%' AND ok=1
  `).get().ts);
  const lastBankTx = db.prepare(`SELECT MAX(date) AS d FROM bank_transactions`).get().d;
  const lastRefresh = db.prepare(`
    SELECT ok, note FROM sync_log WHERE source='financy_refresh' ORDER BY id DESC LIMIT 1
  `).get();
  const bankRefreshSkipped = !!(lastRefresh && (!lastRefresh.ok || /skip/i.test(lastRefresh.note || '')));

  return {
    balances,
    liquidTotal: r(liquidTotal),
    creditAvailable: r(creditAvailable),
    creditBlocked: r(creditBlocked),
    upcomingCardCharge: r(upcomingCardCharge),
    trend,
    staleness: { bankAsOf: lastFinancy || lastBankTx, bankRefreshSkipped },
    flags: computeFlags(db),
  };
}

const UNMATCHED = 'לא משויך';

// Learned recurring movements (see scripts/lib/recurring-detect.mjs), minus
// anything the owner listed in recurring.json → ignore, minus anything that
// already has a manual item with the same name.
export function computeRecurring(db, today = israelToday()) {
  const rows = db.prepare(`
    SELECT date, amount, counterparty, bucket FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS' AND date <= ?
      AND bucket NOT IN ('card_settlement', 'fx_conversion', 'invest')
      AND counterparty IS NOT NULL AND counterparty != ''
  `).all(today);
  const ignore = new Set((recurring.ignore || []).map(normalizeName));
  const manual = new Set((recurring.items || []).map((it) => normalizeName(it.name)));
  const learned = detectRecurring(rows, { today })
    .filter((it) => !ignore.has(normalizeName(it.name)) && !manual.has(normalizeName(it.name)));
  return { learned, manual: recurring.items || [], ignore: recurring.ignore || [] };
}

export function computeCashflow(db, today = israelToday(), horizon = 30) {
  const rate = (settings.usdToIls || 1);
  horizon = Math.min(120, Math.max(7, Number(horizon) || 30));

  // Start from spendable checking balances (ILS + USD converted).
  const startBalance = r(db.prepare(`
    SELECT COALESCE(SUM(balance * CASE WHEN currency='USD' THEN ? ELSE 1 END), 0) AS s
    FROM accounts WHERE type='CHECKING'
  `).get(rate).s);

  // Future-dated actual rows. PENDING duplicates are deleted at sync time
  // (cleanupPendingRows); dedupe here too so a DB that has not synced since
  // that fix landed cannot double-count.
  const seenPending = new Set();
  const futureRows = db.prepare(`
    SELECT account_id, date, amount, counterparty, bucket, status
    FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS' AND date > ?
    ORDER BY date, id
  `).all(today).filter((row) => {
    if (row.status !== 'PENDING') return true;
    const key = [row.account_id, row.date, row.amount, row.counterparty].join('|');
    if (seenPending.has(key)) return false;
    seenPending.add(key);
    return true;
  });
  const futureByDate = new Map();
  const actualBucketMonths = new Set();
  const actualNameMonths = new Set();
  for (const row of futureRows) {
    if (!futureByDate.has(row.date)) futureByDate.set(row.date, []);
    futureByDate.get(row.date).push(row);
    if (row.bucket) actualBucketMonths.add(row.bucket + '|' + row.date.slice(0, 7));
    actualNameMonths.add(normalizeName(row.counterparty) + '|' + row.date.slice(0, 7));
  }

  // Recurring: manual items + learned ones.
  const rec = computeRecurring(db, today);
  const recurringItems = [
    ...rec.manual.map((it) => ({ ...it, learned: false })),
    ...rec.learned,
  ];
  // A recurring item already paid this month (date <= today) must not be
  // projected again on its usual day if that day is still ahead.
  const curMonth = today.slice(0, 7);
  const paidThisMonth = new Set(db.prepare(`
    SELECT DISTINCT counterparty FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS' AND month=? AND date <= ?
  `).all(curMonth, today).map((x) => normalizeName(x.counterparty)));

  // Expected CardCom settlements still inside their window.
  let expectedSettlements = [];
  try {
    const recon = computeReconcile(db, 45);
    if (recon.enabled) {
      expectedSettlements = recon.rows
        .filter((x) => x.status === 'pending')
        .map((x) => ({ date: x.windowFrom < today ? shiftDate(today, 1) : x.windowFrom, name: `זיכוי סליקה (מכירות ${x.label})`, amount: x.expected, settlement: true }));
    }
  } catch { /* optional */ }
  const settleByDate = new Map();
  for (const s of expectedSettlements) {
    if (!settleByDate.has(s.date)) settleByDate.set(s.date, []);
    settleByDate.get(s.date).push(s);
  }

  const days = [];
  let running = startBalance;
  for (let i = 1; i <= horizon; i++) {
    const date = shiftDate(today, i);
    const ym = date.slice(0, 7);
    const dayOfMonth = Number(date.slice(8, 10));
    const lastDayOfMonth = Number(shiftDate(`${shiftDate(`${ym}-01`, 32).slice(0, 7)}-01`, -1).slice(8, 10));
    const items = (futureByDate.get(date) || []).map((row) => ({
      name: row.counterparty || row.bucket || 'תנועה עתידית',
      amount: row.amount,
      actual: true,
    }));
    for (const it of recurringItems) {
      const day = Math.min(it.day, lastDayOfMonth); // day 31 in a 30-day month
      if (day !== dayOfMonth) continue;
      if (it.every === 2 && it.anchorMonth) {
        const mi = (x) => Number(x.slice(0, 4)) * 12 + Number(x.slice(5, 7));
        if ((mi(ym) - mi(it.anchorMonth)) % 2 !== 0) continue;
      }
      if (it.bucket && actualBucketMonths.has(it.bucket + '|' + ym)) continue;
      if (actualNameMonths.has(normalizeName(it.name) + '|' + ym)) continue;
      if (ym === curMonth && paidThisMonth.has(normalizeName(it.name))) continue;
      items.push({ name: it.name, amount: it.amount, learned: !!it.learned });
    }
    for (const s of settleByDate.get(date) || []) items.push({ name: s.name, amount: s.amount, settlement: true });
    const net = items.reduce((sum, it) => sum + it.amount, 0);
    running += net;
    days.push({ date, items, net: r(net), projected: r(running) });
  }

  // The sentence: lowest point, and the first inflow after it.
  let dip = null;
  for (const d of days) if (!dip || d.projected < dip.projected) dip = d;
  let nextInflow = null;
  if (dip) {
    for (const d of days) {
      if (d.date <= dip.date) continue;
      const inflow = d.items.filter((it) => it.amount > 0).reduce((a, it) => a + it.amount, 0);
      if (inflow > 0) { nextInflow = { date: d.date, amount: r(inflow) }; break; }
    }
  }
  const warnIls = settings.cashDipWarnIls ?? 10000;
  return {
    startBalance, horizon, days,
    dip: dip ? { date: dip.date, projected: dip.projected, nextInflow, belowWarn: dip.projected < warnIls } : null,
    endProjected: days.length ? days[days.length - 1].projected : startBalance,
    learned: rec.learned, manual: rec.manual,
    warnIls,
  };
}

// Bridge from the dashboard's CASH view to an ESTIMATE of taxable income.
// These are two different numbers and the gap runs in both directions, so this
// function reports three things separately: adjustments it can compute, amounts
// it knows about but cannot size, and the resulting range. It deliberately does
// not produce a single confident figure — the inputs it is missing (what is
// spent from the second bank account, an asset register for depreciation,
// per-trip detail for foreign-travel caps) are each large enough to move the
// answer by more than the adjustments it CAN make.
export function computeTaxView(db, opts = {}) {
  const rules = loadTaxRules();
  const entityType = opts.entityType ?? settings.entityType ?? null;
  const creditPoints = opts.creditPoints ?? settings.creditPoints ?? null;
  // test/override hook, same pattern as entityType — the config file stays
  // the single source of truth in production
  if (opts.homeOfficeRatio != null) {
    rules.homeOffice = { ...rules.homeOffice, businessRatio: opts.homeOfficeRatio };
  }
  const pnl = computePnl(db);
  const full = pnl.months.filter((m) => !m.partial && m.month >= taxYearStart(israelToday().slice(0, 7)));
  if (full.length === 0) return null;
  const from = full[0].month;
  const to = full[full.length - 1].month;

  const cashProfit = full.reduce((s, m) => s + m.operating_profit, 0);
  const turnoverExVat = full.reduce((s, m) => s + m.revenue_ex_vat, 0);

  // 1. Add back what is not an expense at all. A tax advance is a prepayment of
  //    the very tax being sized — counting it as an expense makes the required
  //    rate fall as you pay more of it.
  const notExpense = [];
  for (const [bucket, why] of Object.entries(rules.notExpenses?.buckets || {})) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(-amount), 0) s FROM bank_transactions
      WHERE amount < 0 AND bucket = ? AND month >= ? AND month <= ?
        AND account_type = 'CHECKING' AND currency = 'ILS'
    `).get(bucket, from, to);
    // Only buckets the P&L actually counts as an expense need adding back;
    // below_line ones are already excluded and would double-count.
    const counted = db.prepare(`
      SELECT COUNT(*) n FROM bank_transactions
      WHERE bucket = ? AND bucket_group != 'below_line' AND bucket_group != 'internal' LIMIT 1
    `).get(bucket).n;
    if (row.s > 0 && counted > 0) notExpense.push({ bucket, amount: r(row.s), why });
  }
  const addBack = notExpense.reduce((s, x) => s + x.amount, 0);

  // 2. Business expenses sitting below the line (classified 'personal') that
  //    the owner marked as business. Each is recognised only at its rule's rate.
  const belowRows = db.prepare(`
    SELECT counterparty, -amount AS amt FROM bank_transactions
    WHERE amount < 0 AND sub_bucket = 'personal' AND month >= ? AND month <= ?
  `).all(from, to);
  const byRule = {}; const unruled = {};
  for (const row of belowRows) {
    const rec = recognitionFor(row.counterparty, rules);
    if (!rec) {
      unruled[row.counterparty] = (unruled[row.counterparty] || 0) + row.amt;
      continue;
    }
    if (!byRule[rec.key]) byRule[rec.key] = { ...rec, gross: 0, deductible: 0 };
    byRule[rec.key].gross += row.amt;
    if (rec.computable) byRule[rec.key].deductible += row.amt * rec.rate;
  }
  const recognised = Object.values(byRule)
    .filter((x) => x.computable)
    .reduce((s, x) => s + x.deductible, 0);

  // 2b. The mirror case: rows the P&L already counts as a FULL expense but
  //     whose rule allows only part. The unrecognised remainder is added back,
  //     otherwise the adjustment would only ever run one way.
  const countedRows = db.prepare(`
    SELECT counterparty, -amount AS amt FROM bank_transactions
    WHERE amount < 0 AND month >= ? AND month <= ?
      AND (bucket_group IS NULL OR (bucket_group != 'below_line' AND bucket_group != 'internal'))
      AND (sub_bucket IS NULL OR sub_bucket != 'personal')
  `).all(from, to);
  const overCounted = {};
  for (const row of countedRows) {
    const rec = recognitionFor(row.counterparty, rules);
    if (!rec || !rec.computable || rec.rate >= 1) continue;
    if (!overCounted[rec.key]) overCounted[rec.key] = { ...rec, gross: 0, addBack: 0 };
    overCounted[rec.key].gross += row.amt;
    overCounted[rec.key].addBack += row.amt * (1 - rec.rate);
  }
  const overCountedTotal = Object.values(overCounted).reduce((s, x) => s + x.addBack, 0);

  // 3. What cannot be sized. Each of these can move the answer more than
  //    everything above, which is why the output is a range.
  // Money that left through a bank account the user never connected. There is
  // no shipped rule that produces such a bucket, so this term is 0 unless the
  // user names one in settings and adds a matching rule. Earlier versions
  // hardcoded a bucket name here; when that bucket did not exist the term was
  // silently 0, and the lower bound of the tax range quietly dropped the one
  // unknown it exists to carry.
  const secondAccountBucket = settings.secondAccountBucket || null;
  const secondAccount = secondAccountBucket
    ? r(db.prepare(`
        SELECT COALESCE(SUM(-amount), 0) s FROM bank_transactions
        WHERE amount < 0 AND bucket = ? AND month >= ? AND month <= ?
      `).get(secondAccountBucket, from, to).s)
    : 0;
  const uncomputable = Object.values(byRule)
    .filter((x) => !x.computable)
    .reduce((s, x) => s + x.gross, 0);
  const unclassified = Object.values(unruled).reduce((s, v) => s + v, 0);

  // Upper bound: none of the second account is a deductible expense.
  const high = cashProfit + addBack + overCountedTotal - recognised;
  // Lower bound: all of it is, and so is every below-line row we could not rate.
  const low = high - secondAccount - uncomputable - unclassified;

  // Advance rate = INCOME TAX only over turnover. BTL is deliberately outside:
  // it has its own advance track at ביטוח לאומי and folding it in here would
  // tell the user to over-pay מקדמות מס הכנסה.
  const months = full.length;
  const rate = (p) => {
    if (turnoverExVat <= 0) return null;
    const { periodTax } = periodIncomeTax(entityType, p, months, creditPoints);
    return Math.round((periodTax / turnoverExVat) * 1000) / 10;
  };
  const estFor = (p) => {
    const { estimate } = periodIncomeTax(entityType, p, months, creditPoints);
    if (!estimate) return null;
    const scale = months / 12;
    return {
      annualisedTaxable: r((p / months) * 12),
      incomeTax: r(estimate.incomeTax * scale),
      nationalInsurance: r(estimate.nationalInsurance * scale),
      healthInsurance: r(estimate.healthInsurance * scale),
      total: r(estimate.total * scale),
      creditPointsUsed: estimate.creditPointsUsed,
      engineNotes: estimate.notes,
    };
  };

  return {
    period: { from, to, months: full.length },
    cashProfit: r(cashProfit),
    turnoverExVat: r(turnoverExVat),
    adjustments: {
      notExpense,
      addBack: r(addBack),
      belowLineBusiness: Object.values(byRule)
        .map((x) => ({ key: x.key, label: x.label, rate: x.rate,
          gross: r(x.gross), deductible: x.computable ? r(x.deductible) : null })),
      recognised: r(recognised),
      overCounted: Object.values(overCounted).map((x) => ({
        key: x.key, label: x.label, rate: x.rate, gross: r(x.gross), addBack: r(x.addBack) })),
      overCountedTotal: r(overCountedTotal),
    },
    cannotSize: {
      secondAccount,
      secondAccountLabel: settings.secondAccountLabel || 'הוצאות מחשבון בנק שני',
      cappedRules: r(uncomputable),
      needsClassification: r(unclassified),
      notes: [
        ...(entityType == null
          ? ['סוג הישות לא הוגדר — חושב לפי מס חברות. הרץ /setup.'] : []),
        ...(rules.homeOffice?.businessRatio == null
          ? ['יחס המשרד בבית טרם הוגדר — הוצאות ארנונה/ועד בית/חשמל לא מותאמות. הרץ /setup.'] : []),
        ...(rules.unknowns || []),
      ],
    },
    estimate: { low: r(low), high: r(high) },
    entityType,
    taxEstimate: { low: estFor(low), high: estFor(high) },
    impliedRatePct: { low: rate(low), high: rate(high) },
    currentRatePct: settings.advanceRatePct,
    disclaimer: rules._disclaimer,
  };
}

// --- CardCom sales (optional module; see config/cardcom.json) ---
function cardcomConfig() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'config', 'cardcom.json'), 'utf8'));
  } catch {
    return { enabled: false };
  }
}

// Sales for an inclusive Israel-calendar date range (/api/sales).
// Rows still carrying the unknown label are flagged so the UI can mark them.
export function computeSalesRange(db, from, to) {
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  if (!ISO.test(from) || !ISO.test(to) || from > to) throw new Error('bad date range');
  const cfg = cardcomConfig();
  const unknownLabel = cfg.unknownLabel || 'אחר';
  const rows = db.prepare(`
    SELECT product, SUM(amount) AS total, COUNT(*) AS count
    FROM cardcom_sales WHERE date >= ? AND date <= ? GROUP BY product
  `).all(from, to);
  const byProduct = {};
  let total = 0;
  let count = 0;
  for (const p of rows) {
    byProduct[p.product] = { total: Math.round(p.total), count: p.count, unknown: p.product === unknownLabel };
    total += p.total;
    count += p.count;
  }
  const days = db.prepare(`
    SELECT date, SUM(amount) AS total, COUNT(*) AS count
    FROM cardcom_sales WHERE date >= ? AND date <= ? GROUP BY date ORDER BY date
  `).all(from, to).map((d) => ({ date: d.date, total: Math.round(d.total), count: d.count }));
  const last = db.prepare(`SELECT MAX(ts) AS ts FROM sync_log WHERE source='cardcom' AND ok=1`).get().ts;
  const lastSync = last ? last.replace(' ', 'T') + 'Z' : null; // sync_log.ts is UTC
  return { enabled: !!cfg.enabled, from, to, total: Math.round(total), count, byProduct, days, lastSync };
}

// CardCom ↔ bank reconciliation for the last `days` days (/api/reconcile).
export function computeReconcile(db, days = 45) {
  const cfg = cardcomConfig();
  if (!cfg.enabled) return { enabled: false, rows: [], unmatchedCredits: [], summary: null };
  const today = israelToday();
  const settlement = { ...DEFAULT_SETTLEMENT, ...(cfg.settlement || {}) };
  // sales back `days`; credits a little further forward than the last window
  const from = shiftDate(today, -days);
  const sales = db.prepare(`
    SELECT date, SUM(amount) AS total FROM cardcom_sales WHERE date >= ? GROUP BY date ORDER BY date
  `).all(from);
  let keywords = Array.isArray(settlement.keywords) ? settlement.keywords : [];
  if (settlement.useCardIssuers) {
    try {
      const rules = JSON.parse(readFileSync(join(ROOT, 'config', 'rules.json'), 'utf8'));
      keywords = keywords.concat(Array.isArray(rules.cardIssuers) ? rules.cardIssuers : []);
    } catch { /* rules optional here */ }
  }
  const credits = db.prepare(`
    SELECT id, date, amount, counterparty, raw_desc FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS' AND amount > 0 AND date >= ?
    ORDER BY date
  `).all(from).filter((row) => isSettlementCredit(row, keywords));
  const out = reconcile({ sales, credits, settlement, today });
  return { enabled: true, days, windowDays: settlement.lagDays + settlement.windowDays, ...out };
}

// --- VAT (מע"מ) --------------------------------------------------------------
// Which reporting period (1 or 2 months) applies, from settings or turnover.
export function vatPeriodMonths(db, opts = {}) {
  const entityType = opts.entityType ?? settings.entityType ?? null;
  if (entityType === 'patur') return null;
  const set = settings.vatPeriodMonths;
  if (set === 1 || set === 2) return { months: set, source: 'settings' };
  const threshold = taxBrackets.vat?.monthlyReportingThreshold || 0;
  const today = israelToday();
  const prevYear = String(Number(today.slice(0, 4)) - 1);
  const turnover = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) s FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS' AND amount > 0
      AND bucket_group='revenue' AND month >= ? AND month <= ?
  `).get(`${prevYear}-01`, `${prevYear}-12`).s;
  // No full prior year in the data: fall back to current-year run-rate.
  let annual = turnover;
  if (annual === 0) {
    const ytd = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) s, COUNT(DISTINCT month) n FROM bank_transactions
      WHERE account_type='CHECKING' AND currency='ILS' AND amount > 0
        AND bucket_group='revenue' AND month >= ?
    `).get(`${today.slice(0, 4)}-01`);
    annual = ytd.n > 0 ? (ytd.s / ytd.n) * 12 : 0;
  }
  return { months: threshold > 0 && annual > threshold ? 1 : 2, source: 'turnover', annualTurnover: r(annual), threshold };
}

// Output VAT and input VAT for a month range, from bank + card rows.
function vatForRange(db, fromMonth, toMonth) {
  const rate = settings.vatRate || 1;
  const part = (rate - 1) / rate; // VAT share of a gross amount
  const rules = loadTaxRules();
  const vi = rules.vatInput || { bank: {}, card: {} };

  const revenue = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) s FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS' AND amount > 0
      AND bucket_group='revenue' AND month >= ? AND month <= ?
  `).get(fromMonth, toMonth).s;
  const outputVat = revenue * part;

  let inputBase = 0;
  const bankRows = db.prepare(`
    SELECT bucket, SUM(amount) s FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS' AND amount < 0
      AND bucket_group='expense' AND month >= ? AND month <= ? GROUP BY bucket
  `).all(fromMonth, toMonth);
  for (const row of bankRows) {
    const f = vi.bank?.[row.bucket];
    if (f === true) inputBase += -row.s;
    else if (typeof f === 'number') inputBase += -row.s * f;
  }
  const cardRows = db.prepare(`
    SELECT COALESCE(sub_bucket, 'other_business') sub, currency, SUM(amount) s FROM bank_transactions
    WHERE account_type='CARD' AND amount < 0 AND month >= ? AND month <= ? GROUP BY sub, currency
  `).all(fromMonth, toMonth);
  for (const row of cardRows) {
    if (row.currency !== 'ILS' && vi.foreignVendorsNoVat !== false) continue;
    const f = vi.card?.[row.sub];
    const ils = row.currency === 'ILS' ? -row.s : -row.s * (settings.usdToIls || 1);
    if (f === true) inputBase += ils;
    else if (typeof f === 'number') inputBase += ils * f;
  }
  const inputVat = inputBase * part;
  return { revenue: r(revenue), outputVat: r(outputVat), inputBase: r(inputBase), inputVat: r(inputVat), net: r(outputVat - inputVat) };
}

function periodFor(month, months) {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const start = months === 2 ? m - ((m - 1) % 2) : m;
  const from = `${y}-${String(start).padStart(2, '0')}`;
  const to = `${y}-${String(start + months - 1).padStart(2, '0')}`;
  const dueMonth = shiftDate(`${to}-01`, 32).slice(0, 7);
  return { from, to, due: `${dueMonth}-${String(settings.vatDueDay || 15).padStart(2, '0')}` };
}

// /api/vat: last closed period (what is due / was paid) + the open one (accruing).
export function computeVat(db, opts = {}) {
  const entityType = opts.entityType ?? settings.entityType ?? null;
  if (entityType === 'patur') return { applicable: false, reason: 'עוסק פטור אינו מדווח מע"מ' };
  const period = vatPeriodMonths(db, { entityType });
  if (!period) return { applicable: false };
  const today = israelToday();
  const curMonth = today.slice(0, 7);
  const open = periodFor(curMonth, period.months);
  const closed = periodFor(shiftDate(`${open.from}-01`, -1).slice(0, 7), period.months);

  const closedVat = vatForRange(db, closed.from, closed.to);
  const openVat = vatForRange(db, open.from, open.to);

  // What actually left the bank as VAT in the month the closed period is due.
  const paid = r(-db.prepare(`
    SELECT COALESCE(SUM(amount), 0) s FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS' AND bucket='tax_vat' AND amount < 0
      AND date >= ? AND date <= ?
  `).get(`${closed.to}-16`, shiftDate(closed.due, 20)).s);
  const daysLeft = daysBetween(today, closed.due);
  let status = 'pending';
  if (closedVat.revenue === 0 && closedVat.inputVat === 0) status = 'empty';
  else if (closedVat.net <= 0) status = paid > 0 ? 'paid' : 'refund';
  else if (paid >= closedVat.net * 0.9) status = 'paid';
  else if (paid > 0 && daysLeft < 0) status = 'partial';
  else if (daysLeft < 0) status = 'late';

  // Threshold watch: config says bi-monthly but turnover crossed the line.
  const threshold = taxBrackets.vat?.monthlyReportingThreshold || 0;
  const warnings = [];
  if (period.months === 2 && period.source === 'settings' && threshold > 0) {
    const t = vatPeriodMonths(db, { entityType });
    const annual = t.annualTurnover ?? 0;
    if (annual > threshold) warnings.push(`המחזור השנתי (${r(annual).toLocaleString('he-IL')} שח) עבר את סף הדיווח החודשי (${threshold.toLocaleString('he-IL')} שח). ייתכן שאתה חייב לעבור לדיווח חודשי.`);
  }
  const detailed = taxBrackets.vat?.detailedReportingThresholdIndividual || 0;
  if (entityType === 'murshe' && detailed > 0 && (settings.vatDueDay || 15) === 15) {
    const ann = vatPeriodMonths(db, { entityType }).annualTurnover;
    if (ann != null && ann > detailed) warnings.push(`מחזור מעל ${detailed.toLocaleString('he-IL')} שח: מ-2026 חלה חובת דיווח מפורט, דיווח חודשי עד ה-23. בדוק עם רו"ח ועדכן vatDueDay.`);
  }

  return {
    applicable: true,
    periodMonths: period.months, periodSource: period.source,
    closed: { ...closed, ...closedVat, paid, status, daysLeft },
    open: { ...open, ...openVat },
    warnings,
    disclaimer: 'הערכה מתנועות הבנק והכרטיס לפי config/tax-rules.json → vatInput. הדוח האמיתי נבנה מחשבוניות; זה מכוון לסדר גודל ולתזרים, לא להגשה.',
  };
}

// --- Advances: year-to-date vs the annual estimate --------------------------
// /api/advances already answers "did this month's advance get paid?". This
// answers "are the advances on track for the year?", the question that
// decides whether the rate should move.
export function computeAdvancesYtd(db, opts = {}) {
  const entityType = opts.entityType ?? settings.entityType ?? null;
  const today = israelToday();
  const yearStart = taxYearStart(today.slice(0, 7));
  const tax = computeTaxView(db, { entityType });
  const paidYtd = r(-db.prepare(`
    SELECT COALESCE(SUM(amount), 0) s FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS' AND bucket='tax_advance' AND amount < 0 AND month >= ?
  `).get(yearStart).s);
  const monthsElapsed = Number(today.slice(5, 7));
  const monthsLeft = 12 - monthsElapsed;
  if (!tax) {
    return { paidYtd, monthsElapsed, monthsLeft, annualEstimate: null, status: 'unknown', note: 'אין עדיין חודש מלא לחישוב הערכת המס השנתית.' };
  }
  const low = tax.taxEstimate.low;
  const high = tax.taxEstimate.high;
  const annual = { low: low.incomeTax, high: high.incomeTax };
  const gap = { low: r(annual.low - paidYtd), high: r(annual.high - paidYtd) };
  const perMonth = monthsLeft > 0 ? { low: r(Math.max(0, gap.low) / monthsLeft), high: r(Math.max(0, gap.high) / monthsLeft) } : null;
  const onTrackPct = annual.high > 0 ? r((paidYtd / (annual.high * (monthsElapsed / 12))) * 100) : null;
  let status = 'on_track';
  if (annual.high > 0 && paidYtd < annual.low * (monthsElapsed / 12) * 0.85) status = 'behind';
  else if (annual.low > 0 && paidYtd > annual.high * (monthsElapsed / 12) * 1.25) status = 'ahead';
  return {
    paidYtd, monthsElapsed, monthsLeft, yearStart,
    annualEstimate: annual, gap, perMonthToClose: perMonth, onTrackPct, status,
    currentRatePct: settings.advanceRatePct ?? null,
    impliedRatePct: tax.impliedRatePct,
    entityType,
    note: 'מס הכנסה בלבד; ביטוח לאומי במסלול מקדמות נפרד. הערכה מתוך פאנל המס, לא שומה.',
  };
}
