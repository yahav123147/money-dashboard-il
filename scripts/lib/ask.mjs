// "שאל את הנתונים": the data pack a question is answered from, the
// read-only escape hatch for questions the pack cannot answer, and the
// parsing of the model's reply. Pure over a db handle; the API route wires
// it to claude -p through the same preflight as the other agents.
import Database from 'better-sqlite3';
import { chmodSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { userInfo } from 'node:os';

const r = (x) => Math.round(x || 0);
const record = () => Object.create(null);
const clip = (value, max = 200) => String(value == null ? '' : value).replace(/\0/g, '').slice(0, max);
export const MAX_DATA_PACK_BYTES = 512 * 1024;
export const MAX_DATA_MONTHS = 13;
export const MAX_TOP_NAMES_PER_MONTH = 6;
export const MAX_PRODUCTS_PER_MONTH = 50;
export const MAX_ACCOUNTS = 50;

// 13 months of the business at the grain most questions need: money in and
// out per month by category, balances, card sales, taxes paid, biggest
// names. Compact on purpose (a few KB), so the answer is one model call.
export function dataPack(db, today, months = 13) {
  months = Math.max(1, Math.min(MAX_DATA_MONTHS, Math.trunc(Number(months) || MAX_DATA_MONTHS)));
  const ym = today.slice(0, 7);
  const y = Number(ym.slice(0, 4)); const m = Number(ym.slice(5, 7));
  const from = `${m - months + 1 <= 0 ? y - 1 : y}-${String(((m - months) % 12 + 12) % 12 + 1).padStart(2, '0')}`;
  const byMonth = record();
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
    const month = clip(x.month, 7);
    const mo = byMonth[month] || (byMonth[month] = { in: 0, out: 0, inBy: record(), outBy: record(), other: { in: 0, out: 0, by: record() } });
    const key = clip(x.bucket || x.bucket_group || 'לא ידוע', 120);
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
    WITH totals AS (
      SELECT month, counterparty, SUM(amount) s, COUNT(*) n FROM bank_transactions
      WHERE account_type='CHECKING' AND currency='ILS' AND month >= ? AND month <= ? AND amount ${sign} 0 AND counterparty != ''
        AND status != 'PENDING' AND bucket_group IN ('revenue','refund','expense','unclassified')
      GROUP BY month, counterparty
    ), ranked AS (
      SELECT month, counterparty, s, n,
        ROW_NUMBER() OVER (PARTITION BY month ORDER BY ABS(s) DESC, counterparty) rank
      FROM totals
    )
    SELECT month, counterparty, s, n FROM ranked WHERE rank <= ${MAX_TOP_NAMES_PER_MONTH} ORDER BY month, rank
  `).all(from, ym);
  const topIn = record(); const topOut = record();
  for (const x of top('>')) (topIn[x.month] = topIn[x.month] || []).push({ name: clip(x.counterparty), amount: r(x.s), n: x.n });
  for (const x of top('<')) (topOut[x.month] = topOut[x.month] || []).push({ name: clip(x.counterparty), amount: r(-x.s), n: x.n });
  const cards = db.prepare(`
    SELECT month, COALESCE(sub_bucket,'other_business') sub, SUM(amount) s FROM bank_transactions
    WHERE account_type='CARD' AND month >= ? AND month <= ? AND amount < 0 GROUP BY month, sub
  `).all(from, ym);
  const cardBy = record();
  for (const x of cards) (cardBy[x.month] = cardBy[x.month] || record())[clip(x.sub, 120)] = r(-x.s);
  let sales = record();
  try {
    for (const x of db.prepare(`SELECT substr(date,1,7) month, COUNT(*) n, SUM(amount) s FROM cardcom_sales WHERE date >= ? GROUP BY 1`).all(from + '-01')) sales[x.month] = { count: x.n, total: r(x.s) };
    const byProduct = db.prepare(`
      WITH totals AS (
        SELECT substr(date,1,7) month, product, COUNT(*) n, SUM(amount) s
        FROM cardcom_sales WHERE date >= ? GROUP BY 1, 2
      ), ranked AS (
        SELECT month, product, n, s,
          ROW_NUMBER() OVER (PARTITION BY month ORDER BY ABS(s) DESC, product) rank
        FROM totals
      )
      SELECT month, product, n, s FROM ranked WHERE rank <= ${MAX_PRODUCTS_PER_MONTH} ORDER BY month, rank
    `).all(from + '-01');
    for (const x of byProduct) { const mo = sales[x.month]; if (mo) (mo.byProduct = mo.byProduct || record())[clip(x.product || 'לא ידוע')] = { count: x.n, total: r(x.s) }; }
  } catch { sales = record(); }
  const accounts = db.prepare(`SELECT type, currency, name, balance, balance_date FROM accounts ORDER BY type LIMIT ${MAX_ACCOUNTS}`).all()
    .map((a) => ({ type: clip(a.type, 40), currency: clip(a.currency, 12), name: clip(a.name), balance: a.balance == null ? null : r(a.balance), asOf: clip(a.balance_date, 30) }));
  const lastSync = db.prepare(`SELECT MAX(ts) ts FROM sync_log WHERE source='financy' AND ok=1`).get().ts;
  const pack = {
    today, from, to: ym, currency: 'ILS',
    note: `in/out = כסף תפעולי בעו"ש (הכנסות, הוצאות, החזרים, לא מסווג), בלי תנועות ממתינות. other = תנועות שאינן תפעוליות: ני"ע, כספי בעלים, חיובי כרטיס (card_settlement), המרות מט"ח; totalIn/totalOut כוללים אותן. cards = חיובי כרטיס לפי קטגוריה. sales = עסקאות קארדקום (לא כסף בבנק עד הזיכוי; עד ${MAX_PRODUCTS_PER_MONTH} מוצרים מובילים בחודש).`,
    months: byMonth, topIn, topOut, cards: cardBy, sales, accounts, lastBankSync: lastSync,
  };
  const bytes = Buffer.byteLength(JSON.stringify(pack), 'utf8');
  if (bytes > MAX_DATA_PACK_BYTES) throw new Error(`חבילת הנתונים לצ'אט גדולה מדי (${bytes} בתים; המקסימום ${MAX_DATA_PACK_BYTES})`);
  return pack;
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

export function shadowDbPath(srcPath) {
  return /\.db$/i.test(srcPath) ? srcPath.replace(/\.db$/i, '.ask-view.db') : `${srcPath}.ask-view.db`;
}
function uniqueShadowDbPath(srcPath) {
  return `${shadowDbPath(srcPath)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
}
export function removeShadowDb(path) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
}
export const ACTIVE_SHADOW_WINDOW_MS = 5 * 60 * 1000;
export function cleanupAskShadows(srcPath, { now = Date.now(), staleMs = ACTIVE_SHADOW_WINDOW_MS } = {}) {
  const legacy = shadowDbPath(srcPath);
  removeShadowDb(legacy);
  const dir = dirname(legacy);
  const prefix = `${basename(legacy)}.`;
  let names;
  try { names = readdirSync(dir); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  const ownArtifact = /^\d+\.[a-z0-9]{4,12}\.tmp(?:\.building)?(?:-(?:wal|shm|journal))?$/i;
  for (const name of names) {
    if (!name.startsWith(prefix) || !ownArtifact.test(name.slice(prefix.length))) continue;
    const path = join(dir, name);
    let modified;
    try { modified = statSync(path).mtimeMs; }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (now - modified > staleMs) rmSync(path, { force: true });
  }
}
function quoteSqlString(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function quoteId(value) { return `"${String(value).replace(/"/g, '""')}"`; }

// Build a fresh, short-lived view for every query. SQLite reads the source
// through its own connection, so committed WAL pages are part of the same
// snapshot. There is no mtime cache that can serve deleted or stale data.
export function buildShadowDb(srcPath, out = uniqueShadowDbPath(srcPath)) {
  removeShadowDb(out);
  const tmp = `${out}.building`;
  removeShadowDb(tmp);
  const previousUmask = process.umask(0o077);
  let db;
  try { db = new Database(tmp); }
  finally { process.umask(previousUmask); }
  let complete = false;
  try {
    chmodSync(tmp, 0o600);
    db.pragma('journal_mode = MEMORY');
    db.pragma('page_size = 4096');
    db.pragma('max_page_count = 32768');
    db.exec(`ATTACH DATABASE ${quoteSqlString(srcPath)} AS src`);
    db.exec('BEGIN');
    for (const [t, cols] of Object.entries(ALLOWED)) {
      const have = new Set(db.prepare(`PRAGMA src.table_info(${quoteId(t)})`).all().map((c) => c.name));
      const use = cols.filter((c) => have.has(c));
      if (!use.length) continue;
      // SQLite uses dynamic typing, so bound text and blobs by their runtime
      // type even when a nominally numeric column contains malformed input.
      const projection = use.map((c) => {
        const q = quoteId(c);
        return `CASE typeof(${q}) WHEN 'text' THEN substr(${q}, 1, 4000) WHEN 'blob' THEN hex(substr(${q}, 1, 2000)) ELSE ${q} END AS ${q}`;
      });
      db.exec(`CREATE TABLE ${quoteId(t)} AS SELECT ${projection.join(', ')} FROM src.${quoteId(t)}`);
    }
    db.exec('COMMIT');
    db.exec('DETACH DATABASE src');
    complete = true;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    throw error;
  } finally {
    db.close();
    if (!complete) removeShadowDb(tmp);
  }
  try { renameSync(tmp, out); chmodSync(out, 0o600); }
  catch (error) { removeShadowDb(tmp); removeShadowDb(out); throw error; }
  return out;
}

export function validateSql(sql) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (Buffer.byteLength(s, 'utf8') > 10000) throw new Error('השאילתה ארוכה מדי');
  if (!/^(select|with)\b/i.test(s)) throw new Error('מותר רק SELECT');
  if (/;/.test(s)) throw new Error('שאילתה אחת בלבד');
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const char = s[i]; const next = s[i + 1];
    if (quote) {
      if (quote === ']' && char === ']' && next === ']') { i += 1; continue; }
      if (char === quote) {
        if (next === quote && quote !== ']') { i += 1; continue; }
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '[') { quote = ']'; continue; }
    if ((char === '-' && next === '-') || (char === '/' && next === '*')) throw new Error('הערות SQL אינן מותרות');
  }
  // defence in depth; the shadow db is the real boundary
  if (/\b(attach|detach|pragma|insert|update|delete|drop|alter|create|replace|vacuum|reindex|readfile|writefile|load_extension)\b/i.test(s) || /\b(sqlite_|pragma_)\w*/i.test(s)) throw new Error('שאילתה לקריאה בלבד');
  if (/(?:^|[^A-Za-z0-9_])(?:rowid|_rowid_|oid)(?:$|[^A-Za-z0-9_])/i.test(s)) throw new Error('עמודת SQLite פנימית אינה מותרת');
  // These expressions can allocate an arbitrary first row before the byte
  // cap sees it. Aggregates and joins remain available, under the worker
  // timeout, but blob/string generators and recursive CTEs are not needed
  // for financial questions.
  if (/\brecursive\b/i.test(s) || /\b(randomblob|zeroblob|hex|quote|printf|format|replace|group_concat|json_group_array|json_group_object)\b/i.test(s)) throw new Error('השאילתה משתמשת בפעולה כבדה שאינה מותרת');
  return s;
}

// The query body, run inside a worker: fresh read-only connection to the
// shadow, rows streamed, iteration stops at the first cap.
export function queryShadow(shadowPath, sql, { maxRows = 200, maxBytes = 60000 } = {}) {
  maxRows = Math.max(1, Math.min(500, Number(maxRows) || 200));
  maxBytes = Math.max(256, Math.min(100000, Number(maxBytes) || 60000));
  const ro = new Database(shadowPath, { readonly: true, fileMustExist: true });
  try {
    ro.pragma('query_only = 1');
    ro.pragma('trusted_schema = OFF');
    ro.pragma('temp_store = FILE');
    ro.pragma('cache_size = -4096');
    ro.pragma('temp.max_page_count = 8192');
    const stmt = ro.prepare(sql);
    if (!stmt.reader) throw new Error('השאילתה לא מחזירה שורות');
    const rows = []; let bytes = 0; let truncated = false; let total = 0;
    for (const row of stmt.iterate()) {
      total += 1;
      const len = Buffer.byteLength(JSON.stringify(row), 'utf8');
      if (rows.length >= maxRows || bytes + len > maxBytes) { truncated = true; break; }
      rows.push(row); bytes += len;
    }
    return { rows, truncated, total: truncated ? `${total - 1}+` : total };
  } finally { ro.close(); }
}

export function querySource(srcPath, shadowPath, sql, opts = {}) {
  // Remove the stable shadow left by versions that cached it. It must not
  // survive an upgrade, a demo reset or deletion of source rows.
  cleanupAskShadows(srcPath);
  try {
    if (opts.heapLimitBytes) {
      const control = new Database(':memory:');
      try { control.pragma(`hard_heap_limit = ${Math.max(16 * 1024 * 1024, Math.min(128 * 1024 * 1024, Number(opts.heapLimitBytes)))}`); }
      finally { control.close(); }
    }
    buildShadowDb(srcPath, shadowPath);
    return queryShadow(shadowPath, sql, opts);
  } finally {
    removeShadowDb(shadowPath);
    removeShadowDb(`${shadowPath}.building`);
  }
}

const QUERY_WORKER = `
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', async () => {
    try {
      const data = JSON.parse(input);
      const mod = await import(data.mod);
      const result = mod.querySource(data.source, data.shadow, data.sql, data.opts);
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: String(error.message || error) }));
    }
  });
`;
// One SELECT in an isolated worker process with a hard timeout. A process is
// intentional here: terminating a JS worker thread cannot interrupt native
// SQLite code, while SIGKILL reliably ends a runaway query and closes it.
export function queryWorkerEnvironment(source = process.env, { platform = process.platform, home } = {}) {
  const env = {};
  for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) if (source[name]) env[name] = String(source[name]);
  if (platform === 'win32') {
    const root = String(source.SystemRoot || source.WINDIR || 'C:\\Windows').replace(/[\\/]+$/, '');
    if (!/^[A-Za-z]:[\\/]Windows$/i.test(root)) throw new Error(`SystemRoot אינו נתיב Windows קבוע ומוכר: ${root}`);
    const fixedHome = String(home || userInfo().homedir || '');
    if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(fixedHome)) throw new Error('לא ניתן לזהות תיקיית בית קבועה לעובד השאילתה');
    env.SystemRoot = root; env.WINDIR = root; env.PATH = `${root}\\System32;${root}`;
    env.TEMP = `${fixedHome.replace(/[\\/]+$/, '')}\\AppData\\Local\\Temp`; env.TMP = env.TEMP;
  } else {
    env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'; env.TMPDIR = '/tmp'; env.TMP = '/tmp'; env.TEMP = '/tmp';
  }
  return env;
}

export function runReadOnlyAsync(srcPath, sql, { maxRows = 200, maxBytes = 60000, timeoutMs = 10000, spawnFn = spawn, workerEnv = queryWorkerEnvironment() } = {}) {
  cleanupAskShadows(srcPath);
  const s = validateSql(sql);
  const shadow = uniqueShadowDbPath(srcPath);
  return new Promise((resolve, reject) => {
    const child = spawnFn(process.execPath, ['--max-old-space-size=64', '--max-semi-space-size=16', '--input-type=module', '--eval', QUERY_WORKER], { stdio: ['pipe', 'pipe', 'pipe'], env: workerEnv, windowsHide: true });
    let done = false; let out = ''; let err = ''; let abortError = null; let killFallback = null;
    const budget = Math.max(50, Math.min(30000, Number(timeoutMs) || 10000));
    const cleanup = () => {
      removeShadowDb(shadow);
      removeShadowDb(`${shadow}.building`);
    };
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (killFallback) clearTimeout(killFallback);
      cleanup();
      fn(value);
    };
    const abort = (error) => {
      if (done || abortError) return;
      abortError = error;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { return finish(reject, error); }
      // SIGKILL normally closes immediately. The fallback prevents an odd
      // platform failure from holding the HTTP request forever.
      killFallback = setTimeout(() => finish(reject, error), 1000);
    };
    const timer = setTimeout(() => abort(new Error(`השאילתה עברה ${Math.max(1, Math.round(budget / 1000))} שניות ונעצרה`)), budget);
    child.on('error', (error) => finish(reject, error));
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (Buffer.byteLength(out, 'utf8') > 150000) abort(new Error('תוצאת השאילתה גדולה מדי'));
    });
    child.stderr.on('data', (chunk) => { if (err.length < 2000) err += chunk; });
    child.on('close', (code) => {
      if (done) return;
      if (abortError) return finish(reject, abortError);
      let message;
      try { message = JSON.parse(out); }
      catch { return finish(reject, new Error((err || `query worker exited ${code}`).trim())); }
      if (code !== 0 || !message.ok) return finish(reject, new Error(message.error || `query worker exited ${code}`));
      finish(resolve, message.result);
    });
    child.stdin.on('error', (error) => abort(error));
    child.stdin.end(JSON.stringify({ mod: import.meta.url, source: srcPath, shadow, sql: s, opts: { maxRows, maxBytes, heapLimitBytes: 128 * 1024 * 1024 } }));
  });
}
// Synchronous form for scripts and tests (no worker; same shadow boundary and caps).
export function runReadOnly(srcPath, sql, opts = {}) {
  cleanupAskShadows(srcPath);
  const s = validateSql(sql);
  return querySource(srcPath, uniqueShadowDbPath(srcPath), s, opts);
}

// The model may answer, or ask for one query first.
export function parseReply(text) {
  const t = String(text || '').trim();
  const sql = t.match(/```sql\s*([\s\S]*?)```/i);
  if (sql) return { sql: sql[1].trim() };
  return { answer: t.replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, ', ') };
}
