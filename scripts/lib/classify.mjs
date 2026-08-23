// Rules-driven classifier.
// classify.mjs is the engine; config/rules.json is the data.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExpenseRules, subBucketFor, BELOW_LINE_SUBS } from './expenses.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULES_PATH = join(ROOT, 'config', 'rules.json');

export function loadRules(path = RULES_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Rules a person approved in /classify live in SQLite (classify_rules), so
// approving and re-classifying are two writes to the same database and
// serialise under its write lock. They go FIRST, newest decision first
// (priority is monotonic; an upsert re-promotes): first match wins, so the
// latest explicit decision always beats an older, broader one.
// Fails closed: if the table cannot be read, nothing is reclassified.
export function explicitRules(db) {
  return db.prepare('SELECT side, match, bucket, bucket_group, priority FROM classify_rules ORDER BY priority DESC, created_at DESC, rowid DESC').all();
}
export function withExplicit(db, rules) {
  const ex = explicitRules(db);
  if (!ex.length) return rules;
  const mk = (r) => ({ match: [r.match], bucket: r.bucket, group: r.bucket_group, source: 'classify' });
  return {
    ...rules,
    inflows: [...ex.filter((r) => r.side === 'in').map(mk), ...(rules.inflows || [])],
    outflows: [...ex.filter((r) => r.side === 'out').map(mk), ...(rules.outflows || [])],
  };
}

function parseAmount(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Financy raw transaction -> row object for upsertTx.
// Data quirks (Global Constraints): amount.chargedAmount.amount may be string or '';
// CHECKING rows date is valueDate (transactionDate is null); type is CHECKING/CARD/SECURITIES.
export function parseFinancyTx(raw) {
  const type = raw.type || '';
  const amount = parseAmount(raw.amount?.chargedAmount?.amount)
    ?? parseAmount(raw.amount?.originalAmount?.amount)
    ?? 0;
  const currency = raw.amount?.chargedAmount?.currency
    || raw.amount?.originalAmount?.currency || 'ILS';
  const date = type === 'CHECKING'
    ? (raw.date?.valueDate || raw.date?.bookingDate || null)
    : (raw.date?.transactionDate || raw.date?.valueDate || raw.date?.bookingDate || null);
  const rawDesc = raw.description?.description || raw.description?.initialClean || '';
  const name = (amount >= 0 ? raw.debtorName : raw.creditorName) || '';
  return {
    id: raw.id,
    account_id: raw.accountId || null,
    account_number: raw.accountNumber || null,
    account_type: type,
    provider: raw.providerId || null,
    date,
    month: date ? date.slice(0, 7) : null,
    amount,
    currency,
    counterparty: (name || rawDesc).trim(),
    raw_desc: rawDesc,
    status: raw.status || null,
    side: amount >= 0 ? 'in' : 'out',
    bucket: null,
    bucket_group: null,
    raw_json: JSON.stringify(raw),
  };
}

function matchRule(rule, text, desc, rules) {
  const haystack = rule.field === 'desc' ? desc : text;
  if (rule.matchAll) return rule.matchAll.every((s) => haystack.includes(s));
  if (rule.matchRef) return (rules[rule.matchRef] || []).some((s) => haystack.includes(s));
  return (rule.match || []).some((s) => haystack.includes(s));
}

// Classify one row (pre refund-pairing). Row needs: account_type, currency,
// amount, counterparty, raw_desc.
export function classifyRow(row, rules, expRules = loadExpenseRules()) {
  if (row.account_type === 'SECURITIES') return { bucket: 'securities_dup', group: 'internal' };
  if (row.account_type === 'CARD') {
    const { sub, channel } = subBucketFor(row.counterparty, expRules);
    const group = BELOW_LINE_SUBS.includes(sub) ? 'below_line' : 'expense';
    return { bucket: 'cards', group, sub, channel };
  }
  if (row.currency !== 'ILS') return { bucket: 'fx_account', group: 'internal' };
  // counterparty falls back to raw_desc when the bank sends no name, so
  // concatenating both reproduces the name+description haystack of the analysis.
  const text = row.counterparty + ' ' + row.raw_desc;
  const desc = row.raw_desc;
  if (row.amount >= 0) {
    for (const rule of rules.inflows) {
      if (matchRule(rule, text, desc, rules)) return { bucket: rule.bucket, group: rule.group, explicit: rule.source === 'classify' };
    }
    return { ...rules.inflowDefault };
  }
  for (const rule of rules.outflows) {
    if (matchRule(rule, text, desc, rules)) return { bucket: rule.bucket, group: rule.group, explicit: rule.source === 'classify' };
  }
  const d = rules.outflowDefaults;
  return Math.abs(row.amount) >= d.largeThreshold ? { ...d.large } : { ...d.small };
}

export function tokens(s) {
  return (s || '').replace(/["'׳״.\-]/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
}

function subset(a, b) {
  return a.length > 0 && a.every((x) => b.includes(x));
}

export function tokenMatch(a, b) {
  return subset(a, b) || subset(b, a);
}

// Re-classifies every bank_transactions row: sets side/bucket/bucket_group.
// Two passes: rules, then refund pairing.
//
// Refund pairing treats money received as a POOL that a refund draws down.
// An outflow bucketed direct/suppliers_other/unclassified becomes
// refund_direct when it is on the explicit refundPairs list, or when its
// counterparty (>= 2 tokens) has enough UNSPENT money already received, dated
// on or before the outflow, to cover it. Every match consumes what it uses,
// oldest money first, so a client who paid 100k over a year justifies 100k of
// refunds in total, not 100k against every separate payment to anyone who
// shares a word with their name.
export function classifyAll(db, fileRules = loadRules()) {
  // BEGIN IMMEDIATE: the explicit rules are read and every row rewritten
  // inside one write lock, so an approval cannot land between the read and
  // the rewrite and be undone by it.
  return db.transaction(() => classifyAllLocked(db, withExplicit(db, fileRules))).immediate();
}

// The body, for callers that already hold the write transaction (an
// approval or an undo re-runs the whole classification in its own tx).
export function classifyAllLocked(db, rules) {
  const rows = db.prepare(`
    SELECT id, account_type, amount, currency, counterparty, raw_desc, date
    FROM bank_transactions
  `).all();

  const expRules = loadExpenseRules();
  const results = new Map();
  for (const row of rows) results.set(row.id, classifyRow(row, rules, expRules));

  // Each inflow carries its date and a running balance. Three things have to
  // hold for a derived match, and each one caught a real misclassification:
  // size (one ILS 3.20 credit from a phone company was licence to reclassify a
  // year of phone bills), direction in time (money received in August turned an
  // ordinary January purchase into a refund), and non-reuse (one receipt
  // justifying an unlimited number of separate payments).
  const inflows = rows
    .filter((r) => r.account_type === 'CHECKING' && r.currency === 'ILS' && r.amount > 0)
    .map((r) => ({ t: tokens(r.counterparty), date: r.date || '', left: r.amount }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const pairTokenSets = (rules.refundPairs || []).map(tokens);
  // explicit suppliers (e.g. the lawyer) are never refund candidates, even if
  // their name partially token-matches some client inflow
  const supplierNames = rules.suppliers || [];

  // Draw down the pool chronologically, so an earlier refund is funded before a
  // later one rather than by whichever row the database happened to return first.
  const candidates = rows
    .filter((r) => r.account_type === 'CHECKING' && r.currency === 'ILS' && r.amount < 0)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // Spend `need` from the matching, already-received, unspent inflows. Returns
  // false and spends nothing when they cannot cover it.
  const drawDown = (ot, onOrBefore, need, mustCover) => {
    const pool = inflows.filter((i) => i.date <= onOrBefore && i.left > 0 && tokenMatch(ot, i.t));
    const available = pool.reduce((s, i) => s + i.left, 0);
    if (mustCover && available < need) return false;
    let rest = need;
    for (const i of pool) {
      const take = Math.min(i.left, rest);
      i.left -= take;
      rest -= take;
      if (rest <= 0) break;
    }
    return true;
  };

  for (const row of candidates) {
    const res = results.get(row.id);
    if (res.explicit) continue; // a person decided this one in /classify
    if (!['direct', 'suppliers_other', 'unclassified'].includes(res.bucket)) continue;
    if (supplierNames.some((s) => (row.counterparty || '').includes(s))) continue;
    const ot = tokens(row.counterparty);
    const amount = Math.abs(row.amount);
    const onOrBefore = row.date || '';
    // An explicitly listed pair is the user's own decision, taken as given. It
    // still spends from the pool, so it cannot fund a second refund as well.
    if (pairTokenSets.some((pt) => tokenMatch(ot, pt))) {
      drawDown(ot, onOrBefore, amount, false);
      results.set(row.id, { bucket: 'refund_direct', group: 'refund' });
      continue;
    }
    // Derived matches have to earn it. A one-word counterparty is a subset of
    // far too many names to mean anything.
    if (ot.length < 2) continue;
    if (drawDown(ot, onOrBefore, amount, true)) {
      results.set(row.id, { bucket: 'refund_direct', group: 'refund' });
    }
  }

  const update = db.prepare(`
    UPDATE bank_transactions SET side=?, bucket=?, bucket_group=?, sub_bucket=?, expense_channel=?, updated_at=datetime('now')
    WHERE id=?
  `);
  for (const row of rows) {
    const res = results.get(row.id);
    update.run(row.amount >= 0 ? 'in' : 'out', res.bucket, res.group,
      res.sub ?? null, res.channel ?? null, row.id);
  }
  return rows.length;
}
