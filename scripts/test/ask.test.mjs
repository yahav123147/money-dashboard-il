import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, readdirSync, existsSync, statSync, utimesSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertTx } from '../lib/db.mjs';
import { buildShadowDb, cleanupAskShadows, dataPack, runReadOnly, runReadOnlyAsync, parseReply, shadowDbPath, queryWorkerEnvironment, MAX_DATA_PACK_BYTES, MAX_PRODUCTS_PER_MONTH, MAX_ACCOUNTS } from '../lib/ask.mjs';
import { guardLocalJsonRequest, runGatedClaudeAsync, MAX_ASK_PROMPT_BYTES } from '../lib/ask-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
function tmpDb(t, name) {
  const dir = mkdtempSync(join(tmpdir(), 'money-ask-'));
  const p = join(dir, name);
  const db = openDb(p);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, path: p };
}
function shadowFiles(path) {
  const prefix = basename(shadowDbPath(path));
  return readdirSync(dirname(path)).filter((f) => f.startsWith(prefix));
}
const tx = (db, id, date, amount, counterparty, bucket, group, status = 'completed') => upsertTx(db, {
  id, account_id: 'c', account_number: '1', account_type: 'CHECKING', provider: 't', date, month: date.slice(0, 7),
  amount, currency: 'ILS', counterparty, raw_desc: counterparty, status, side: amount > 0 ? 'in' : 'out',
  bucket, bucket_group: group, raw_json: '{}',
});

test('dataPack: per-month in/out by bucket, top names, pending excluded, 13-month window', (t) => {
  const { db } = tmpDb(t, 'test-ask1.db');
  tx(db, 'i1', '2026-07-03', 30000, 'לקוח א', 'direct', 'revenue');
  tx(db, 'i2', '2026-07-20', 12000, 'לקוח ב', 'direct', 'revenue');
  tx(db, 'o1', '2026-07-05', -8000, 'שכירות', 'rent', 'expense');
  tx(db, 'p1', '2026-08-30', -5000, 'עתידי', 'rent', 'expense', 'PENDING');
  tx(db, 'old', '2025-06-01', 99999, 'ישן', 'direct', 'revenue');
  tx(db, 'sec', '2026-07-09', 500000, 'מכירת ני"ע', 'securities_sale', 'below_line');
  tx(db, 'pin', '2026-07-25', 70000, 'לקוח עתידי', 'direct', 'revenue', 'PENDING');
  const pack = dataPack(db, '2026-08-10');
  assert.equal(pack.from, '2025-08');
  assert.equal(pack.months['2026-07'].in, 42000, 'operating money only');
  assert.equal(pack.months['2026-07'].other.in, 500000);
  assert.equal(pack.months['2026-07'].totalIn, 542000);
  assert.equal(pack.months['2026-07'].out, 8000);
  assert.equal(pack.months['2026-07'].net, 34000);
  assert.equal(pack.months['2026-07'].outBy.rent, 8000);
  assert.equal(pack.topIn['2026-07'][0].name, 'לקוח א');
  assert.ok(!pack.topIn['2026-07'].some((x) => x.name === 'לקוח עתידי'), 'pending rows are not in the top names either');
  assert.equal(pack.months['2026-08'], undefined, 'pending rows do not count');
  assert.equal(pack.months['2025-06'], undefined, 'outside the window');
});

test('dataPack is structurally bounded and prototype-like external names remain data', (t) => {
  const { db } = tmpDb(t, 'bounded-pack.db');
  for (let i = 0; i < 20; i++) tx(db, `top-${i}`, '2026-07-01', 100000 - i, `${'ל'.repeat(300)}-${i}`, 'direct', 'revenue');
  const sale = db.prepare(`INSERT INTO cardcom_sales (deal_id, date, amount, product) VALUES (?, '2026-07-01', ?, ?)`);
  const account = db.prepare(`INSERT INTO accounts (id, provider, number, type, name, currency, balance) VALUES (?, 't', ?, 'CHECKING', ?, 'ILS', 1)`);
  db.transaction(() => {
    for (let i = 0; i < 200; i++) sale.run(`sale-${i}`, 100000 - i, i === 0 ? '__proto__' : i === 1 ? 'constructor' : `${'מ'.repeat(300)}-${i}`);
    for (let i = 0; i < 60; i++) account.run(`account-${i}`, String(i), `${'ח'.repeat(300)}-${i}`);
  })();
  const pack = dataPack(db, '2026-08-10', 999);
  assert.equal(pack.topIn['2026-07'].length, 6); assert.ok(pack.topIn['2026-07'].every((x) => x.name.length <= 200));
  assert.equal(Object.getPrototypeOf(pack.sales['2026-07'].byProduct), null);
  assert.equal(Object.hasOwn(pack.sales['2026-07'].byProduct, '__proto__'), true);
  assert.ok(Object.keys(pack.sales['2026-07'].byProduct).length <= MAX_PRODUCTS_PER_MONTH);
  assert.equal(pack.accounts.length, MAX_ACCOUNTS); assert.ok(pack.accounts.every((x) => x.name.length <= 200));
  assert.ok(Buffer.byteLength(JSON.stringify(pack), 'utf8') <= MAX_DATA_PACK_BYTES);
  assert.equal(pack.from, '2025-08', 'requested history is capped to 13 months');
});

test('runReadOnly: SELECT only, one statement, fresh read-only connection, capped rows', (t) => {
  const { db, path } = tmpDb(t, 'test-ask2.db');
  for (let i = 0; i < 250; i++) tx(db, `r${i}`, '2026-07-01', -10, 'x', 'rent', 'expense');
  const res = runReadOnly(path, 'SELECT id FROM bank_transactions');
  assert.equal(res.rows.length, 200); assert.equal(res.truncated, true); assert.equal(res.total, '200+', 'iteration stops at the cap');
  assert.throws(() => runReadOnly(path, 'DELETE FROM bank_transactions'), /SELECT/);
  assert.throws(() => runReadOnly(path, 'SELECT 1; DELETE FROM bank_transactions'), /אחת/);
  assert.throws(() => runReadOnly(path, 'WITH x AS (SELECT 1) INSERT INTO accounts (id) VALUES (1)'), /קריאה/);
  assert.throws(() => runReadOnly(path, "SELECT name FROM pragma_table_info('bank_transactions')"), /קריאה/, 'pragma is refused outright; the schema is in the prompt');
  assert.throws(() => runReadOnly(path, 'PRAGMA journal_mode = DELETE'), /SELECT/);
  assert.throws(() => runReadOnly(path, 'SELECT * FROM sqlite_master'), /לא מותרת|קריאה/);
  for (const q of ['SELECT rowid FROM bank_transactions', 'SELECT _ROWID_ FROM bank_transactions', 'SELECT oid FROM bank_transactions', 'SELECT b."rowid" FROM bank_transactions b', 'SELECT [oid] FROM bank_transactions', 'SELECT `_rowid_` FROM bank_transactions']) {
    assert.throws(() => runReadOnly(path, q), /פנימית/, q);
  }
  assert.throws(() => runReadOnly(path, 'SELECT hex(randomblob(10000000))'), /כבדה/, 'one expression cannot allocate an oversized first row');
  assert.throws(() => runReadOnly(path, 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT * FROM n'), /כבדה/);
  assert.throws(() => runReadOnly(path, 'WITH/**/RECURSIVE n(x) AS (SELECT 1) SELECT * FROM n'), /הערות|כבדה/, 'comments cannot split WITH RECURSIVE');
  assert.throws(() => runReadOnly(path, 'SELECT randomblob/**/(10000000)'), /הערות|כבדה/, 'comments cannot split a heavy function call');
  assert.throws(() => runReadOnly(path, 'SELECT "randomblob"(10000000)'), /כבדה/, 'quoted heavy function identifiers are refused');
  assert.throws(() => runReadOnly(path, `SELECT '${'x'.repeat(10001)}'`), /ארוכה/);
  // the boundary is the shadow db, not a regex: every bypass shape hits "no such table"
  db.exec(`CREATE TABLE private_table (secret TEXT); INSERT INTO private_table VALUES ('x')`);
  for (const q of [
    'SELECT * FROM private_table',
    'SELECT * FROM bank_transactions, private_table',
    'SELECT * FROM [private_table]',
    'SELECT * FROM "private_table"',
    'WITH x AS (SELECT secret FROM private_table) SELECT * FROM x',
    'SELECT b.id FROM bank_transactions b JOIN counterparties c ON 1',
    'SELECT * FROM balance_snapshots',
    'SELECT raw_json FROM bank_transactions',
  ]) assert.throws(() => runReadOnly(path, q), /no such (table|column)/i, q);
  assert.throws(() => runReadOnly(path, 'SELECT * FROM /* gap */ private_table'), /הערות/, 'SQL comments are rejected before execution');
  const small = runReadOnly(path, 'SELECT id, counterparty FROM bank_transactions', { maxBytes: 300 });
  assert.ok(small.rows.length < 20 && small.truncated, 'byte cap cuts the result');
  db.prepare(`UPDATE bank_transactions SET raw_desc=? WHERE id='r0'`).run('x'.repeat(100000));
  const bounded = runReadOnly(path, `SELECT raw_desc FROM bank_transactions WHERE id='r0'`);
  assert.equal(bounded.rows[0].raw_desc.length, 4000, 'external text is bounded before a result row is built');
  db.prepare(`UPDATE bank_transactions SET amount=? WHERE id='r1'`).run(Buffer.alloc(100000, 1));
  const malformed = runReadOnly(path, `SELECT amount FROM bank_transactions WHERE id='r1'`);
  assert.equal(malformed.rows[0].amount.length, 4000, 'SQLite dynamic typing cannot smuggle an oversized blob through a numeric column');
  assert.deepEqual(shadowFiles(path), [], 'a successful query leaves no financial shadow behind');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_transactions').get().n, 250, 'nothing changed');
});

test('runReadOnly: sees committed WAL changes and deletes a legacy cached shadow', (t) => {
  const { db, path } = tmpDb(t, 'test-ask-wal.sqlite');
  assert.notEqual(shadowDbPath(path), path, 'a non-.db source never aliases its own shadow path');
  tx(db, 'one', '2026-07-01', 10, 'a', 'direct', 'revenue');
  assert.equal(runReadOnly(path, 'SELECT COUNT(*) n FROM bank_transactions').rows[0].n, 1);
  tx(db, 'two', '2026-07-02', 20, 'b', 'direct', 'revenue');
  assert.ok(db.pragma('journal_mode', { simple: true }).toLowerCase() === 'wal');
  writeFileSync(shadowDbPath(path), 'legacy stale copy');
  assert.equal(runReadOnly(path, 'SELECT COUNT(*) n FROM bank_transactions').rows[0].n, 2, 'new committed WAL row is visible immediately');
  assert.equal(existsSync(path), true, 'query cleanup never removes a non-.db source');
  assert.deepEqual(shadowFiles(path), [], 'legacy and per-query shadows are gone');
});

test('shadow files are private; invalid SQL still cleans legacy and only stale workers are swept', (t) => {
  const { path } = tmpDb(t, 'test-ask-private-shadow.db');
  const base = shadowDbPath(path);
  const built = `${base}.1234.deadbeef.tmp`;
  buildShadowDb(path, built);
  assert.equal(statSync(built).mode & 0o777, 0o600);
  rmSync(built, { force: true });

  writeFileSync(base, 'legacy');
  assert.throws(() => runReadOnly(path, 'not sql'), /SELECT/);
  assert.equal(existsSync(base), false, 'legacy is removed before SQL validation');

  const old = `${base}.1234.aaaabbbb.tmp`;
  const oldBuilding = `${base}.1234.ccccdddd.tmp.building`;
  const active = `${base}.1234.eeeeffff.tmp`;
  for (const file of [old, oldBuilding, active]) writeFileSync(file, 'shadow');
  const now = Date.now();
  for (const file of [old, oldBuilding]) utimesSync(file, new Date(now - 5000), new Date(now - 5000));
  cleanupAskShadows(path, { now, staleMs: 1000 });
  assert.equal(existsSync(old), false); assert.equal(existsSync(oldBuilding), false);
  assert.equal(existsSync(active), true, 'an active-window file is not raced');
  rmSync(active, { force: true });
});

test('every model call is gated again, including a revoked second disclosure', async () => {
  let allowed = true; let runs = 0; let gates = 0;
  const pinned = { command: '/fixed/claude', argsPrefix: [], displayPath: '/fixed/claude' };
  const exactEnv = { PATH: '/safe' };
  const deps = {
    preflight: async () => { gates += 1; return allowed ? { ok: true, claude: pinned, claudeEnv: exactEnv } : { ok: false, error: 'revoked' }; },
    run: async (_prompt, options) => { runs += 1; assert.equal(options.claude, pinned); assert.equal(options.claudeEnv, exactEnv); return { ok: true, text: 'ok' }; },
  };
  assert.equal((await runGatedClaudeAsync('pack', deps)).ok, true);
  allowed = false;
  const second = await runGatedClaudeAsync('raw rows', deps);
  assert.equal(second.gateDenied, true); assert.match(second.error, /revoked/);
  assert.equal(gates, 2); assert.equal(runs, 1, 'revoked raw rows never reach a model process');

  const source = readFileSync(join(ROOT, 'app', 'api', 'ask', 'route.js'), 'utf8');
  assert.equal((source.match(/runGatedClaudeAsync\(/g) || []).length, 2, 'both route model calls use the gate wrapper');
  assert.ok(source.indexOf('cleanupAskShadows(DB_PATH)') < source.indexOf('dataPack(db, today)'), 'pack-only answers also retire old shadows');
  assert.ok(source.indexOf('guardLocalJsonRequest(req)') < source.indexOf('req.json()'), 'HTTP guard runs before parsing user input');
  assert.match(source, /gateDenied \? 403 : 502/);
});

test('Ask prompt cap rejects before auth or model spawn', async () => {
  let gates = 0; let runs = 0;
  const result = await runGatedClaudeAsync('א'.repeat(MAX_ASK_PROMPT_BYTES), {
    preflight: async () => { gates += 1; return { ok: true }; },
    run: async () => { runs += 1; return { ok: true, text: 'unexpected' }; },
  });
  assert.equal(result.inputRejected, true); assert.equal(gates, 0); assert.equal(runs, 0);
});

test('local Ask API guard allows same/missing Origin and refuses rebinding, cross-origin and non-JSON requests', () => {
  const request = (headers) => new Request('http://127.0.0.1:8422/api/ask', { method: 'POST', headers, body: '{}' });
  assert.deepEqual(guardLocalJsonRequest(request({ Host: '127.0.0.1:8422', 'Content-Type': 'application/json' })), { ok: true });
  assert.deepEqual(guardLocalJsonRequest(request({ Host: '127.0.0.1:8422', Origin: 'http://127.0.0.1:8422', 'Content-Type': 'application/json; charset=utf-8' })), { ok: true });
  assert.equal(guardLocalJsonRequest(request({ Host: 'money.attacker.test:8422', 'Content-Type': 'application/json' })).status, 403);
  assert.equal(guardLocalJsonRequest(request({ Host: '127.0.0.1:8422', Origin: 'https://attacker.test', 'Content-Type': 'application/json' })).status, 403);
  assert.equal(guardLocalJsonRequest(request({ Host: '127.0.0.1:8422', Origin: 'http://localhost:8422', 'Content-Type': 'application/json' })).status, 403, 'different host is not same-origin');
  assert.equal(guardLocalJsonRequest(request({ Host: '127.0.0.1:8422', 'Content-Type': 'text/plain' })).status, 415);
});

test('query worker environment drops inherited Node/proxy/TLS/debug settings', () => {
  const env = queryWorkerEnvironment({ LANG: 'he_IL.UTF-8', PATH: '/attacker', NODE_OPTIONS: '--require x', HTTPS_PROXY: 'http://proxy', SSL_CERT_FILE: '/x', DEBUG: '*' }, { platform: 'linux' });
  assert.deepEqual(env, { LANG: 'he_IL.UTF-8', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp' });
  const source = readFileSync(join(ROOT, 'scripts', 'lib', 'ask.mjs'), 'utf8');
  assert.match(source, /env: workerEnv/);
});

test('parseReply: sql block vs answer; dashes normalised', () => {
  assert.deepEqual(parseReply('צריך לבדוק:\n```sql\nSELECT 1\n```'), { sql: 'SELECT 1' });
  assert.deepEqual(parseReply('ביולי נכנסו 42 אלף ₪ — בעיקר מלקוח א'), { answer: 'ביולי נכנסו 42 אלף ₪, בעיקר מלקוח א' });
});

test('runReadOnlyAsync: runs in a worker and is killed on timeout', async (t) => {
  const { db, path } = tmpDb(t, 'test-ask3.db');
  for (let i = 0; i < 300; i++) tx(db, `r${i}`, '2026-07-01', -10, 'x', 'rent', 'expense');
  const ok = await runReadOnlyAsync(path, 'SELECT COUNT(*) n FROM bank_transactions');
  assert.equal(ok.rows[0].n, 300);
  assert.deepEqual(shadowFiles(path), [], 'successful worker cleans its shadow');
  // a self-join explosion: 300^4 rows, never finishes in 300ms
  await assert.rejects(runReadOnlyAsync(path, 'SELECT COUNT(*) FROM bank_transactions a, bank_transactions b, bank_transactions c, bank_transactions d', { timeoutMs: 300 }), /נעצרה/);
  assert.deepEqual(shadowFiles(path), [], 'killed worker cleans partial and complete shadows');
});
