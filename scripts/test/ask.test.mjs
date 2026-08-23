import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertTx } from '../lib/db.mjs';
import { dataPack, runReadOnly, parseReply } from '../lib/ask.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
function tmpDb(t, name) {
  const p = join(ROOT, 'data', name);
  for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true });
  const db = openDb(p);
  t.after(() => { db.close(); for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true }); });
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
  const pack = dataPack(db, '2026-08-10');
  assert.equal(pack.from, '2025-08');
  assert.equal(pack.months['2026-07'].in, 42000, 'operating money only');
  assert.equal(pack.months['2026-07'].other.in, 500000);
  assert.equal(pack.months['2026-07'].totalIn, 542000);
  assert.equal(pack.months['2026-07'].out, 8000);
  assert.equal(pack.months['2026-07'].net, 34000);
  assert.equal(pack.months['2026-07'].outBy.rent, 8000);
  assert.equal(pack.topIn['2026-07'][0].name, 'לקוח א');
  assert.equal(pack.months['2026-08'], undefined, 'pending rows do not count');
  assert.equal(pack.months['2025-06'], undefined, 'outside the window');
});

test('runReadOnly: SELECT only, one statement, fresh read-only connection, capped rows', (t) => {
  const { db, path } = tmpDb(t, 'test-ask2.db');
  for (let i = 0; i < 250; i++) tx(db, `r${i}`, '2026-07-01', -10, 'x', 'rent', 'expense');
  const res = runReadOnly(path, 'SELECT id FROM bank_transactions');
  assert.equal(res.rows.length, 200); assert.equal(res.truncated, true); assert.equal(res.total, 250);
  assert.throws(() => runReadOnly(path, 'DELETE FROM bank_transactions'), /SELECT/);
  assert.throws(() => runReadOnly(path, 'SELECT 1; DELETE FROM bank_transactions'), /אחת/);
  assert.throws(() => runReadOnly(path, 'WITH x AS (SELECT 1) INSERT INTO accounts (id) VALUES (1)'), /קריאה/);
  assert.ok(runReadOnly(path, "SELECT name FROM pragma_table_info('accounts')").rows.length > 0, 'schema introspection is fine on a read-only connection');
  assert.throws(() => runReadOnly(path, 'PRAGMA journal_mode = DELETE'), /SELECT/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_transactions').get().n, 250, 'nothing changed');
});

test('parseReply: sql block vs answer; dashes normalised', () => {
  assert.deepEqual(parseReply('צריך לבדוק:\n```sql\nSELECT 1\n```'), { sql: 'SELECT 1' });
  assert.deepEqual(parseReply('ביולי נכנסו 42 אלף ₪ — בעיקר מלקוח א'), { answer: 'ביולי נכנסו 42 אלף ₪, בעיקר מלקוח א' });
});
