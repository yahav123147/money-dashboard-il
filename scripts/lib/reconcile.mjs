// Sales ↔ bank reconciliation. Pure: takes sale rows and bank credits,
// returns one row per (acquirer, settlement period) with a verdict.
//
// Two things a naive "sales this month vs credits next month" gets wrong:
//  1. Installment sales (תשלומים) are paid out one installment per month,
//     so a ₪12,000 sale in 12 payments expects ₪1,000 a month, not ₪12,000.
//  2. Not every sale is cleared by the same acquirer. CardCom routes AmEx to
//     Isracard and PayPal to PayPal; those credits look different in the bank
//     (or land in a different account). Each acquirer is reconciled alone.
//
//   daily   : every landing day D expects one credit in [D, D+window]
//   monthly : every landing month expects credits in that month
//             (dayOfMonth ±5 when set, otherwise the whole month)
// Expected net = scheduled × (1 − feePct/100).

export const DEFAULT_SETTLEMENT = {
  mode: 'daily', lagDays: 1, windowDays: 4, feePct: 0, tolerancePct: 2, dayOfMonth: null,
  keywords: ['קארדקום', 'CARDCOM'], useCardIssuers: true,
  // acquirer → how its credit looks in the bank. The primary acquirer uses
  // `keywords` above; others are listed here. An acquirer with no keywords
  // still gets rows (they will read "missing"), which is the point.
  acquirers: {},
};

export function shiftIso(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const addMonths = (iso, n) => {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + n;
  const d = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(Number(iso.slice(8, 10)), last);
  return `${d.toISOString().slice(0, 7)}-${String(day).padStart(2, '0')}`;
};
const nextMonth = (ym) => shiftIso(`${ym}-01`, 32).slice(0, 7);
const lastDay = (ym) => shiftIso(`${nextMonth(ym)}-01`, -1);
const r = (v) => Math.round(v);

export function isSettlementCredit(row, keywords) {
  if (!(Number(row.amount) > 0)) return false;
  const hay = `${row.counterparty || ''} ${row.raw_desc || ''}`.toLowerCase();
  return keywords.some((k) => k && hay.includes(String(k).toLowerCase()));
}

// One sale → the credits it should produce: [{ date, amount }].
// sale: { date, amount, payments?, firstPayment?, constPayment? }
export function scheduleFor(sale, lagDays, mode = 'daily') {
  const n = Math.max(1, Number(sale.payments) || 1);
  // Daily settlers pay a few days after the sale; monthly settlers pay the
  // whole month in the following month.
  const land = mode === 'monthly' ? addMonths(sale.date, 1) : shiftIso(sale.date, lagDays);
  if (n === 1) return [{ date: land, amount: Number(sale.amount) || 0 }];
  const first = Number(sale.firstPayment) || sale.amount / n;
  const rest = Number(sale.constPayment) || (sale.amount - first) / (n - 1);
  const out = [{ date: land, amount: first }];
  for (let k = 1; k < n; k++) out.push({ date: addMonths(land, k), amount: rest });
  return out;
}

function periodOf(date, cfg) {
  if (cfg.mode === 'monthly') {
    const ym = date.slice(0, 7);
    let from = `${ym}-01`;
    let to = lastDay(ym);
    if (cfg.dayOfMonth) {
      const anchor = `${ym}-${String(cfg.dayOfMonth).padStart(2, '0')}`;
      from = shiftIso(anchor, -5);
      to = shiftIso(anchor, 5);
    }
    return { key: ym, label: ym, from, to, multi: true };
  }
  return { key: date, label: date, from: date, to: shiftIso(date, cfg.windowDays), multi: false };
}

export function reconcile({ sales, credits, settlement = {}, today, horizonTo = null }) {
  const cfg = { ...DEFAULT_SETTLEMENT, ...settlement };
  const feeMul = 1 - (Number(cfg.feePct) || 0) / 100;
  const tol = (Number(cfg.tolerancePct) || 0) / 100;
  const primary = cfg.primaryAcquirer || 'CardCom';
  const acqKeywords = { [primary]: cfg.keywords || [] };
  for (const [name, a] of Object.entries(cfg.acquirers || {})) acqKeywords[name] = Array.isArray(a?.keywords) ? a.keywords : [];

  // 1. Build expected credits per (acquirer, period) from the schedule.
  const periods = new Map();
  // Periods whose window is already open get a row too (they read "pending").
  const until = horizonTo || (cfg.mode === 'monthly' ? lastDay(today.slice(0, 7)) : shiftIso(today, cfg.windowDays));
  for (const s of sales) {
    const acq = s.acquirer || primary;
    if (!acqKeywords[acq]) acqKeywords[acq] = [];
    for (const c of scheduleFor(s, cfg.lagDays, cfg.mode)) {
      if (c.date > until) continue;
      const p = periodOf(c.date, cfg);
      const key = `${acq}|${p.key}`;
      if (!periods.has(key)) periods.set(key, { ...p, acquirer: acq, gross: 0, fromInstallments: 0, sales: 0 });
      const e = periods.get(key);
      e.gross += c.amount;
      if ((Number(s.payments) || 1) > 1) e.fromInstallments += c.amount;
      e.sales += 1;
    }
  }

  // 2. Classify credits by acquirer.
  const pool = credits.map((c) => {
    let acq = null;
    for (const [name, kws] of Object.entries(acqKeywords)) if (kws.length && isSettlementCredit(c, kws)) { acq = name; break; }
    return { ...c, amount: Number(c.amount) || 0, used: false, acquirer: acq };
  }).filter((c) => c.acquirer).sort((a, b) => a.date.localeCompare(b.date));

  // 3. Match. Two passes so a period with no credit cannot steal a neighbour's.
  const list = [...periods.values()].map((p) => ({ ...p, expected: r(p.gross * feeMul), matched: [] }))
    .sort((a, b) => a.from.localeCompare(b.from));
  const within = (c, p) => !c.used && c.acquirer === p.acquirer && c.date >= p.from && c.date <= p.to;
  for (const p of list) {
    if (p.multi) { p.matched = pool.filter((c) => within(c, p)); for (const c of p.matched) c.used = true; continue; }
    const fit = pool.find((c) => within(c, p) && Math.abs(c.amount - p.expected) <= Math.max(1, p.expected * tol));
    if (fit) { fit.used = true; p.matched = [fit]; }
  }
  for (const p of list) {
    if (p.multi || p.matched.length) continue;
    const cands = pool.filter((c) => within(c, p));
    if (!cands.length) continue;
    const best = cands.reduce((a, c) => (Math.abs(c.amount - p.expected) < Math.abs(a.amount - p.expected) ? c : a));
    best.used = true; p.matched = [best];
  }

  const rows = list.filter((p) => p.expected > 0 || p.matched.length).map((p) => {
    const received = r(p.matched.reduce((a, c) => a + c.amount, 0));
    const diff = received - p.expected;
    let status;
    if (p.matched.length && Math.abs(diff) <= Math.max(1, p.expected * tol)) status = 'matched';
    else if (p.matched.length && diff > 0) status = 'matched'; // more than scheduled (older installments) is not a problem
    else if (p.matched.length) status = 'partial';
    else if (p.to < today) status = 'missing';
    else status = 'pending';
    return {
      key: `${p.acquirer}|${p.key}`, acquirer: p.acquirer, label: p.label,
      gross: r(p.gross), fromInstallments: r(p.fromInstallments), sales: p.sales,
      expected: p.expected, received, diff: r(diff), status, windowFrom: p.from, windowTo: p.to,
      credits: p.matched.map((c) => ({ id: c.id, date: c.date, amount: r(c.amount), desc: c.counterparty || c.raw_desc || '' })),
    };
  }).reverse();

  const unmatchedCredits = pool.filter((c) => !c.used)
    .map((c) => ({ id: c.id, date: c.date, amount: r(c.amount), acquirer: c.acquirer, desc: c.counterparty || c.raw_desc || '' }));

  const { summary, byAcquirer } = summarize(rows);
  return { mode: cfg.mode, primaryAcquirer: primary, rows, unmatchedCredits, summary, byAcquirer };
}

export const ACQUIRER_LABELS = { CardCom: 'קארדקום', Isracard: 'ישראכרט (אמקס)', PayPal: 'פייפאל', Unknown: 'לא ידוע' };
export const acquirerLabel = (a) => ACQUIRER_LABELS[a] || a;

// Totals over a row set. Exported so callers that filter rows re-summarise.
export function summarize(rows) {
  const summary = { matched: 0, partial: 0, missing: 0, pending: 0, missingAmount: 0, diffAmount: 0 };
  const byAcquirer = {};
  for (const row of rows) {
    summary[row.status] += 1;
    if (row.status === 'missing') summary.missingAmount += row.expected;
    if (row.status === 'partial') summary.diffAmount += row.diff;
    const a = byAcquirer[row.acquirer] || (byAcquirer[row.acquirer] = { expected: 0, received: 0, missing: 0, periods: 0 });
    a.expected += row.expected; a.received += row.received; a.periods += 1;
    if (row.status === 'missing') a.missing += row.expected;
    else if (row.status === 'partial') a.missing += -row.diff;
  }
  for (const a of Object.values(byAcquirer)) { a.expected = r(a.expected); a.received = r(a.received); a.missing = r(a.missing); }
  summary.missingAmount = r(summary.missingAmount); summary.diffAmount = r(summary.diffAmount);
  return { summary, byAcquirer };
}
