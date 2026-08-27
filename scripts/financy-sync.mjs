#!/usr/bin/env node
// Financy sync: refresh (quota-guarded) -> accounts -> transactions
// (last 35 days) -> classify -> balance snapshots -> counterparties.
// Idempotent: every write is an upsert, safe to re-run after machine sleep.
//
// Usage: npm run sync            (= node scripts/financy-sync.mjs)
//        node scripts/financy-sync.mjs --no-refresh
//   --no-refresh  skip the on-demand connections refresh (saves provider
//                 credits; use during dev/testing).
//
// Credentials come from scripts/lib/secrets.mjs (env vars, .env, or macOS
// Keychain). Missing credentials exit with a clear message instead of a
// stack trace — that is the first thing a new user would hit.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSecret } from './lib/secrets.mjs';
import {
  openDb, upsertTx, cleanupPendingRows, logSync,
  refreshCountThisMonth, rebuildCounterparties,
} from './lib/db.mjs';
import { parseFinancyTx, classifyAll } from './lib/classify.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const settings = JSON.parse(readFileSync(join(ROOT, 'config', 'settings.json'), 'utf8'));

const NO_REFRESH = process.argv.includes('--no-refresh');
const LOOKBACK_DAYS = 35;
// --from YYYY-MM-DD pulls a longer window than the nightly 35 days: what you
// run once after connecting a new bank or card, to backfill its history.
const FROM_ARG = (process.argv.find((a) => a.startsWith('--from=')) || '').split('=')[1] || null;
if (FROM_ARG && !/^\d{4}-\d{2}-\d{2}$/.test(FROM_ARG)) {
  console.error('--from חייב להיות בפורמט YYYY-MM-DD');
  process.exit(1);
}
const REFRESH_WAIT_MS = 120_000; // max wait for providers to leave FETCHING
const POLL_MS = 10_000;

const CRED_NAMES = ['FINANCY_CLIENT_ID', 'FINANCY_CLIENT_SECRET', 'FINANCY_USER_ID'];

export function financyEnv() {
  const env = { ...process.env };
  const missing = [];
  for (const name of CRED_NAMES) {
    const v = getSecret(name);
    if (v) env[name] = v;
    else missing.push(name);
  }
  return { env, missing };
}

// The financy CLI is a PINNED local dependency, invoked from node_modules.
// It must never be `npx -y financy`: that resolves the newest published
// version at run time, on every sync, with FINANCY_CLIENT_SECRET already in
// the child environment. Whoever publishes the next version would be running
// code on the machine holding the bank credentials. Bump the pin in
// package.json deliberately, after reading the diff.
const FINANCY_BIN = join(ROOT, 'node_modules', '.bin', 'financy');

function financy(env, ...args) {
  if (!existsSync(FINANCY_BIN)) {
    console.error('financy CLI חסר. הרץ npm install ואז נסה שוב.');
    process.exit(1);
  }
  const out = execFileSync(FINANCY_BIN, [...args, '--json'], {
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

// Israel calendar day regardless of where the machine lives or sleeps.
function israelToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
}

function daysAgo(isoDay, n) {
  const d = new Date(isoDay + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- refresh (quota guard: max settings.financyMonthlyRefreshCap/month) ----------
async function maybeRefresh(db, env) {
  // The monthly cap below is counted from THIS install's own sync_log. It
  // cannot see another app, MCP or cron refreshing the same Financy account,
  // and two refreshers on one account burn provider credits twice. A user in
  // that situation sets financyRefreshEnabled:false and lets the other one
  // own the refresh; this install still reads the freshly synced data.
  if (settings.financyRefreshEnabled === false) {
    logSync(db, 'financy_refresh', 0, 'skipped: financyRefreshEnabled=false');
    return 'skipped (financyRefreshEnabled=false)';
  }
  if (NO_REFRESH) {
    logSync(db, 'financy_refresh', 0, 'skipped: --no-refresh');
    return 'skipped (--no-refresh)';
  }
  const used = refreshCountThisMonth(db);
  // Null/absent cap must not silently disable refresh (used >= null is
  // used >= 0, always true) — default to a conservative once-a-day-ish cap.
  const cap = settings.financyMonthlyRefreshCap ?? 30;
  if (used >= cap) {
    logSync(db, 'financy_refresh', 0, `skipped: monthly cap reached (${used}/${cap})`);
    return `skipped (cap ${used}/${cap})`;
  }
  try {
    financy(env, 'refresh');
    logSync(db, 'financy_refresh', 1, `refresh ${used + 1}/${cap}`);
  } catch (err) {
    logSync(db, 'financy_refresh', 0, `refresh failed: ${String(err.message).slice(0, 300)}`);
    return 'refresh FAILED (continuing with cached data)';
  }
  // Refresh is async on the provider side: wait until no connection is FETCHING
  // so the accounts/transactions pull below sees fresh data.
  const deadline = Date.now() + REFRESH_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    try {
      const st = financy(env, 'status');
      if (!(st.data || []).some((c) => c.status === 'FETCHING')) break;
    } catch {
      break; // status is best-effort; do not fail the sync over it
    }
  }
  return `refreshed (${used + 1}/${cap})`;
}

// ---------- accounts ----------
export function pickBalance(acc) {
  const bals = acc.balances || [];
  const own = bals.filter((b) => !b.creditLimitIncluded);
  if (acc.accountType === 'CARD') {
    // Card debt accrued since last settlement = interimBooked (ILS part is primary).
    const interim = own.filter((b) => b.balanceType === 'interimBooked');
    const pick = interim.find((b) => b.balanceAmount?.currency === 'ILS') || interim[0];
    return pick || null;
  }
  return (
    own.find((b) => b.balanceType === 'expected') ||
    own.find((b) => b.balanceType === 'closingBooked') ||
    own[0] || bals[0] || null
  );
}

export function securitiesValue(acc) {
  const pos = acc.securityPositions || [];
  if (pos.length === 0) return null;
  let total = 0;
  for (const p of pos) {
    const units = num(p.unitsNumber);
    const price = num(p.averageBuyingPrice?.amount);
    if (units != null && price != null) total += units * price; // approximation
  }
  return Math.round(total * 100) / 100;
}

function syncAccounts(db, env, today) {
  const res = financy(env, 'accounts', 'list', '--all');
  const accounts = res.data || [];

  const upsertAccount = db.prepare(`
    INSERT INTO accounts (id, provider, number, type, name, currency, balance,
      balance_date, credit_limit, securities_value, raw_json, updated_at)
    VALUES (@id, @provider, @number, @type, @name, @currency, @balance,
      @balance_date, @credit_limit, @securities_value, @raw_json, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      provider=excluded.provider, number=excluded.number, type=excluded.type,
      name=excluded.name, currency=excluded.currency, balance=excluded.balance,
      balance_date=excluded.balance_date, credit_limit=excluded.credit_limit,
      securities_value=excluded.securities_value, raw_json=excluded.raw_json,
      updated_at=datetime('now')
  `);
  const upsertSnap = db.prepare(`
    INSERT INTO balance_snapshots (snap_date, account_id, currency, balance)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(snap_date, account_id, currency) DO UPDATE SET balance=excluded.balance
  `);

  let snapRows = 0;
  const applyAll = db.transaction(() => {
    for (const acc of accounts) {
      const secValue = acc.accountType === 'SECURITIES' ? securitiesValue(acc) : null;
      const picked = pickBalance(acc);
      // Hapoalim returns "ILY" for shekel accounts. It is not an ISO code, and
      // every ILS query in the dashboard would silently skip the account.
      const real = (c) => (c && c !== 'XXX' ? (c === 'ILY' ? 'ILS' : c) : null);
      const currency =
        real(acc.currency) ||
        real(picked?.balanceAmount?.currency) ||
        real(acc.creditLimit?.currency) ||
        'ILS';
      upsertAccount.run({
        id: acc.id,
        provider: acc.providerId || null,
        number: acc.accountNumber || null,
        type: acc.accountType || null,
        name: acc.accountName || acc.accountNumber || null,
        currency,
        balance: picked ? num(picked.balanceAmount?.amount) : secValue,
        balance_date: picked?.referenceDate || today,
        credit_limit: num(acc.creditLimit?.amount),
        securities_value: secValue,
        raw_json: JSON.stringify(acc),
      });

      // Snapshots: one row per account/currency for today.
      if (acc.accountType === 'SECURITIES') {
        if (secValue != null) {
          upsertSnap.run(today, acc.id, 'ILS', secValue);
          snapRows++;
        }
      } else if (acc.accountType === 'CARD') {
        const interims = (acc.balances || []).filter(
          (b) => b.balanceType === 'interimBooked' && !b.creditLimitIncluded
        );
        for (const b of interims) {
          const v = num(b.balanceAmount?.amount);
          if (v == null) continue;
          upsertSnap.run(today, acc.id, b.balanceAmount?.currency || currency, v);
          snapRows++;
        }
      } else {
        const v = picked ? num(picked.balanceAmount?.amount) : null;
        if (v != null) {
          upsertSnap.run(today, acc.id, currency, v);
          snapRows++;
        }
      }
    }
  });
  applyAll();
  return { accountCount: accounts.length, snapRows };
}

// ---------- transactions ----------
// Network first (no lock held), then the rows, the pending cleanup, the
// classification and the counterparties rollup in ONE write transaction:
// upsertTx writes rows with bucket=null, so a failure after the upsert but
// before classifyAll must roll the rows back too, never leave nulls.
function fetchTransactions(env, from) {
  const res = financy(env, 'transactions', 'list', '--from', from, '--all');
  return (res.data || []).filter((raw) => raw.id);
}
function applyTransactions(db, raws) {
  const ids = [];
  let classified = 0; let pending = null;
  db.transaction(() => {
    for (const raw of raws) { upsertTx(db, parseFinancyTx(raw)); ids.push(raw.id); }
    pending = cleanupPendingRows(db, ids);
    classified = classifyAll(db);
    rebuildCounterparties(db);
  }).immediate();
  return { ids, pending, classified };
}

// ---------- main ----------
async function main() {
  const { env, missing } = financyEnv();
  if (missing.length) {
    console.error('חסרים פרטי התחברות ל-Financy:', missing.join(', '));
    console.error('הרץ /setup בתוך Claude Code, או קבע אותם כמשתני סביבה / בקובץ .env בשורש הפרויקט.');
    console.error('נרשמים ב-https://www.npmjs.com/package/financy — חשבון נפרד לכל עסק.');
    process.exitCode = 1;
    return;
  }
  const db = openDb();
  const today = israelToday();
  try {
    const refreshNote = await maybeRefresh(db, env);
    const { accountCount, snapRows } = syncAccounts(db, env, today);
    const from = FROM_ARG || daysAgo(today, LOOKBACK_DAYS);
    const raws = fetchTransactions(env, from);
    const { ids: txIds, pending, classified } = applyTransactions(db, raws);
    const note = `refresh=${refreshNote}; accounts=${accountCount}; snapshots=${snapRows}; tx(from ${from})=${txIds.length}; pendingDrop=${pending.stale}stale+${pending.dupes}dup; classified=${classified}`;
    logSync(db, 'financy', 1, note);
    console.log('financy-sync OK:', note);
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err).slice(0, 500);
    logSync(db, 'financy', 0, msg);
    console.error('financy-sync FAILED:', msg);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

// isMain guard: importing this module (tests import pickBalance/securitiesValue)
// must never start a live sync.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
