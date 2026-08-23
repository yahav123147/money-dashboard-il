// "שאל את הנתונים": the data pack a question is answered from, the
// read-only escape hatch for questions the pack cannot answer, and the
// parsing of the model's reply. Pure over a db handle; the API route wires
// it to claude -p through the same preflight as the other agents.
import Database from 'better-sqlite3';
import { statSync, renameSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

const r = (x) => Math.round(x || 0);

// 13 months of the business at the grain most questions need: money in and
// out per month by category, balances, card sales, taxes paid, biggest
// names. Compact on purpose (a few KB), so the answer is one model call.
export function dataPack(db, today, months = 13) {
  const ym = today.slice(0, 7);
  const y = Number(ym.slice(0, 4)); const m = Number(ym.slice(5, 7));
  const from = `${m - months + 1 <= 0 ? y - 1 : y}-${String(((m - months) % 12 + 12) % 12 + 1).padStart(2, '0')}`;
  const byMonth = {};
  const rows = db.prepare(`
    SELECT month, bucket_group, bucket, SUM(amount) s, COUNT(*) n FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS' AND month >= ? AND month <= ? AND status != 'PENDING'
    GROUP BY month, bucket_group, bucket ORDER BY month
  `).all(from, ym);
  // Operating money (revenue / refunds / expenses / unclassified) apart from
  // below-the-line and internal movements (securities, owner money, card
  // settlements, FX): "how much came in" means the first, and the model
  // should not have to subtract the second by eye.
  const OPERATING = new Set(['revenue', 'refund', 'expense', 'unclassified']);
  for (const x of rows) {
    const mo = byMonth[x.month] || (byMonth[x.month] = { in: 0, out: 0, inBy: {}, outBy: {}, other: { in: 0, out: 0, by: {} } });
    const key = x.bucket || x.bucket_group;
    if (OPERATING.has(x.bucket_group)) {
      if (x.s >= 0) { mo.in += x.s; mo.inBy[key] = r((mo.inBy[key] || 0) + x.s); }
      else { mo.out += -x.s; mo.outBy[key] = r((mo.outBy[key] || 0) - x.s); }
    } else {
      if (x.s >= 0) mo.other.in += x.s; else mo.other.out += -x.s;
      mo.other.by[key] = r((mo.other.by[key] || 0) + x.s);
    }
  }
  for (const mo of Object.values(byMonth)) { mo.in = r(mo.in); mo.out = r(mo.out); mo.net = r(mo.in - mo.out); mo.other.in = r(mo.other.in); mo.other.out = r(mo.other.out); mo.totalIn = r(mo.in + mo.other.in); mo.totalOut = r(mo.out + mo.other.out); }
  const top = (sign) => db.prepare(`
    SELECT month, counterparty, SUM(amount) s, COUNT(*) n FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS' AND month >= ? AND month <= ? AND amount ${sign} 0 AND counterparty != ''
      AND status != 'PENDING' AND bucket_group IN ('revenue','refund','expense','unclassified')
    GROUP BY month, counterparty ORDER BY month, ABS(SUM(amount)) DESC
  `).all(from, ym);
  const topIn = {}; const topOut = {};
  for (const x of top('>')) { (topIn[x.month] = topIn[x.month] || []); if (topIn[x.month].length < 6) topIn[x.month].push({ name: x.counterparty, amount: r(x.s), n: x.n }); }
  for (const x of top('<')) { (topOut[x.month] = topOut[x.month] || []); if (topOut[x.month].length < 6) topOut[x.month].push({ name: x.counterparty, amount: r(-x.s), n: x.n }); }
  const cards = db.prepare(`
    SELECT month, COALESCE(sub_bucket,'other_business') sub, SUM(amount) s FROM bank_transactions
    WHERE account_type='CARD' AND month >= ? AND month <= ? AND amount < 0 GROUP BY month, sub
  `).all(from, ym);
  const cardBy = {};
  for (const x of cards) (cardBy[x.month] = cardBy[x.month] || {})[x.sub] = r(-x.s);
  let sales = {};
  try {
    for (const x of db.prepare(`SELECT substr(date,1,7) month, COUNT(*) n, SUM(amount) s FROM cardcom_sales WHERE date >= ? GROUP BY 1`).all(from + '-01')) sales[x.month] = { count: x.n, total: r(x.s) };
    const byProduct = db.prepare(`SELECT substr(date,1,7) month, product, COUNT(*) n, SUM(amount) s FROM cardcom_sales WHERE date >= ? GROUP BY 1, 2`).all(from + '-01');
    for (const x of byProduct) { const mo = sales[x.month]; if (mo) (mo.byProduct = mo.byProduct || {})[x.product || 'לא ידוע'] = { count: x.n, total: r(x.s) }; }
  } catch { sales = {}; }
  const accounts = db.prepare(`SELECT type, currency, name, balance, balance_date FROM accounts ORDER BY type`).all()
    .map((a) => ({ type: a.type, currency: a.currency, name: a.name, balance: a.balance == null ? null : r(a.balance), asOf: a.balance_date }));
  const lastSync = db.prepare(`SELECT MAX(ts) ts FROM sync_log WHERE source='financy' AND ok=1`).get().ts;
  return {
    today, from, to: ym, currency: 'ILS',
    note: 'in/out = כסף תפעולי בעו"ש (הכנסות, הוצאות, החזרים, לא מסווג), בלי תנועות ממתינות. other = תנועות שאינן תפעוליות: ני"ע, כספי בעלים, חיובי כרטיס (card_settlement), המרות מט"ח; totalIn/totalOut כוללים אותן. cards = חיובי כרטיס לפי קטגוריה. sales = עסקאות קארדקום (לא כסף בבנק עד הזיכוי).',
    months: byMonth, topIn, topOut, cards: cardBy, sales, accounts, lastBankSync: lastSync,
  };
}

export const SCHEMA_DOC = `טבלאות (SQLite, קריאה בלבד; רק אלה קיימות):
bank_transactions(id, account_type 'CHECKING'|'CARD', date 'YYYY-MM-DD', month 'YYYY-MM', amount (חיובי=נכנס, שלילי=יוצא), currency, counterparty, raw_desc, status ('PENDING' = עתידי), bucket, bucket_group 'revenue'|'expense'|'refund'|'internal'|'below_line'|'unclassified', sub_bucket)
accounts(id, type, name, currency, balance, balance_date)
cardcom_sales(deal_id, date, amount, product, acquirer, payments)
sync_log(source, ts, ok)
classify_rules(side, match, bucket, bucket_group, counterparty, created_at)
classify_proposals(side, counterparty, match, bucket, status, confidence, reason)`;

// The tables and columns a question may read. Enforced structurally: the
// query runs against a shadow database that contains ONLY these, built from
// the real one. A name outside the list is "no such table", whatever the SQL
// looks like (comments, brackets, comma joins, CTEs included).
export const ALLOWED = {
  bank_transactions: ['id', 'account_type', 'date', 'month', 'amount', 'currency', 'counterparty', 'raw_desc', 'status', 'bucket', 'bucket_group', 'sub_bucket'],
  accounts: ['id', 'type', 'name', 'currency', 'balance', 'balance_date'],
  cardcom_sales: ['deal_id', 'date', 'amount', 'product', 'acquirer', 'payments'],
  sync_log: ['source', 'ts', 'ok'],
  classify_rules: ['side', 'match', 'bucket', 'bucket_group', 'counterparty', 'created_at'],
  classify_proposals: ['side', 'counterparty', 'match', 'bucket', 'status', 'confidence', 'reason'],
};
export const ALLOWED_TABLES = Object.keys(ALLOWED);

export function shadowDbPath(srcPath) { return srcPath.replace(/\.db$/, '') + '.ask-view.db'; }
// Rebuild the shadow when the source changed (file mtime+size), else reuse.
export function buildShadowDb(srcPath) {
  const out = shadowDbPath(srcPath);
  const st = statSync(srcPath);
  const stamp = `${st.mtimeMs}|${st.size}`;
  try {
    const cur = new Database(out, { readonly: true, fileMustExist: true });
    const row = cur.prepare(`SELECT value FROM meta WHERE key='source'`).get();
    cur.close();
    if (row && row.value === stamp) return out;
  } catch { /* rebuild */ }
  const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const db = new Database(tmp);
  try {
    db.exec(`ATTACH DATABASE '${srcPath.replace(/'/g, "''")}' AS src`);
    for (const [t, cols] of Object.entries(ALLOWED)) {
      const have = new Set(db.prepare(`PRAGMA src.table_info(${t})`).all().map((c) => c.name));
      const use = cols.filter((c) => have.has(c));
      if (!use.length) continue;
      db.exec(`CREATE TABLE ${t} AS SELECT ${use.map((c) => `"${c}"`).join(', ')} FROM src.${t}`);
    }
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
    db.prepare(`INSERT INTO meta VALUES ('source', ?)`).run(stamp);
    db.exec('DETACH DATABASE src');
  } finally { db.close(); }
  renameSync(tmp, out);
  return out;
}

export function validateSql(sql) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(s)) throw new Error('מותר רק SELECT');
  if (/;/.test(s)) throw new Error('שאילתה אחת בלבד');
  // defence in depth; the shadow db is the real boundary
  if (/\b(attach|detach|pragma|insert|update|delete|drop|alter|create|replace|vacuum|reindex|readfile|writefile|load_extension)\b/i.test(s) || /\b(sqlite_|pragma_)\w*/i.test(s)) throw new Error('שאילתה לקריאה בלבד');
  return s;
}

// The query body, run inside a worker: fresh read-only connection to the
// shadow, rows streamed, iteration stops at the first cap.
export function queryShadow(shadowPath, sql, { maxRows = 200, maxBytes = 60000 } = {}) {
  const ro = new Database(shadowPath, { readonly: true, fileMustExist: true });
  try {
    ro.pragma('query_only = 1');
    const stmt = ro.prepare(sql);
    if (!stmt.reader) throw new Error('השאילתה לא מחזירה שורות');
    const rows = []; let bytes = 0; let truncated = false; let total = 0;
    for (const row of stmt.iterate()) {
      total += 1;
      const len = JSON.stringify(row).length;
      if (rows.length >= maxRows || bytes + len > maxBytes) { truncated = true; break; }
      rows.push(row); bytes += len;
    }
    return { rows, truncated, total: truncated ? `${total - 1}+` : total };
  } finally { ro.close(); }
}

const WORKER = `
  const { parentPort, workerData } = require('node:worker_threads');
  import(workerData.mod).then((m) => {
    try { parentPort.postMessage({ ok: true, result: m.queryShadow(workerData.shadow, workerData.sql, workerData.opts) }); }
    catch (e) { parentPort.postMessage({ ok: false, error: String(e.message || e) }); }
  }).catch((e) => parentPort.postMessage({ ok: false, error: String(e.message || e) }));
`;
// One SELECT in a worker thread with a hard timeout: a slow or huge query
// can neither block the server nor outlive its budget (the worker is
// terminated, which also closes its connection).
export function runReadOnlyAsync(srcPath, sql, { maxRows = 200, maxBytes = 60000, timeoutMs = 10000 } = {}) {
  const s = validateSql(sql);
  const shadow = buildShadowDb(srcPath);
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { eval: true, workerData: { mod: import.meta.url, shadow, sql: s, opts: { maxRows, maxBytes } } });
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); w.terminate(); fn(v); } };
    const timer = setTimeout(() => finish(reject, new Error(`השאילתה עברה ${Math.round(timeoutMs / 1000)} שניות ונעצרה`)), timeoutMs);
    w.on('message', (m) => (m.ok ? finish(resolve, m.result) : finish(reject, new Error(m.error))));
    w.on('error', (e) => finish(reject, e));
    w.on('exit', (code) => { if (!done && code !== 0) finish(reject, new Error(`worker exited ${code}`)); });
  });
}
// Synchronous form for scripts and tests (no worker; same shadow boundary and caps).
export function runReadOnly(srcPath, sql, opts = {}) {
  const s = validateSql(sql);
  return queryShadow(buildShadowDb(srcPath), s, opts);
}

// The model may answer, or ask for one query first.
export function parseReply(text) {
  const t = String(text || '').trim();
  const sql = t.match(/```sql\s*([\s\S]*?)```/i);
  if (sql) return { sql: sql[1].trim() };
  return { answer: t.replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, ', ') };
}
