import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertTx } from '../lib/db.mjs';
import { dataPack, runReadOnly, runReadOnlyAsync, parseReply, shadowDbPath } from '../lib/ask.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
function tmpDb(t, name) {
  const p = join(ROOT, 'data', name);
  for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true });
  const db = openDb(p);
  t.after(() => { db.close(); for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true }); rmSync(shadowDbPath(p), { force: true }); });
  return { db, path: p };
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
  // the boundary is the shadow db, not a regex: every bypass shape hits "no such table"
  db.exec(`CREATE TABLE private_table (secret TEXT); INSERT INTO private_table VALUES ('x')`);
  for (const q of [
    'SELECT * FROM private_table',
    'SELECT * FROM bank_transactions, private_table',
    'SELECT * FROM /* gap */ private_table',
    'SELECT * FROM [private_table]',
    'SELECT * FROM "private_table"',
    'WITH x AS (SELECT secret FROM private_table) SELECT * FROM x',
    'SELECT b.id FROM bank_transactions b JOIN counterparties c ON 1',
    'SELECT * FROM balance_snapshots',
    'SELECT raw_json FROM bank_transactions',
  ]) assert.throws(() => runReadOnly(path, q), /no such (table|column)/i, q);
  const small = runReadOnly(path, 'SELECT id, counterparty FROM bank_transactions', { maxBytes: 300 });
  assert.ok(small.rows.length < 20 && small.truncated, 'byte cap cuts the result');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_transactions').get().n, 250, 'nothing changed');
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
  // a self-join explosion: 300^4 rows, never finishes in 300ms
  await assert.rejects(runReadOnlyAsync(path, 'SELECT COUNT(*) FROM bank_transactions a, bank_transactions b, bank_transactions c, bank_transactions d', { timeoutMs: 300 }), /נעצרה/);
});
