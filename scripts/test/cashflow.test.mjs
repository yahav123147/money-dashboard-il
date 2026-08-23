import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertTx } from '../lib/db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
function tmpDb(t, name) {
  const p = join(ROOT, 'data', name);
  for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true });
  const db = openDb(p);
  t.after(() => { db.close(); for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true }); });
  return db;
}
const tx = (db, id, date, amount, counterparty, bucket, group) => upsertTx(db, {
  id, account_id: 'c', account_number: '1', account_type: 'CHECKING', provider: 't', date, month: date.slice(0, 7),
  amount, currency: 'ILS', counterparty, raw_desc: counterparty, status: 'completed', side: amount > 0 ? 'in' : 'out',
  bucket, bucket_group: group, raw_json: '{}',
});

test('computeCashflow projects learned recurring items on their day, skips ones already paid this month, reports the dip', async (t) => {
  const { computeCashflow, shiftDate } = await import('../../lib/queries.js');
  const db = tmpDb(t, 'test-cashflow.db');
  db.prepare(`INSERT INTO accounts (id, provider, number, type, name, currency, balance) VALUES ('c','t','1','CHECKING','עו"ש','ILS', 20000)`).run();
  const today = '2026-08-10';
  // rent on the 25th for 5 months → learned, due 08-25 inside a 30-day window
  for (const m of ['04', '05', '06', '07']) tx(db, `r${m}`, `2026-${m}-25`, -15000, 'שכירות', 'rent', 'expense');
  // salary on the 5th → already paid this month (08-05), must NOT be projected again in August but yes in September
  for (const m of ['05', '06', '07', '08']) tx(db, `s${m}`, `2026-${m}-05`, -8000, 'משכורת', 'team', 'expense');
  // client on the 28th → learned inflow
  for (const m of ['05', '06', '07']) tx(db, `i${m}`, `2026-${m}-28`, 30000, 'לקוח א', 'direct', 'revenue');

  const cf = computeCashflow(db, today, 30);
  assert.equal(cf.days.length, 30);
  const by = Object.fromEntries(cf.days.map((d) => [d.date, d]));
  assert.ok(by['2026-08-25'].items.some((it) => it.name === 'שכירות' && it.amount === -15000));
  assert.ok(!cf.days.some((d) => d.date.startsWith('2026-08') && d.items.some((it) => it.name === 'משכורת')), 'salary already paid in August');
  assert.ok(by['2026-09-05'].items.some((it) => it.name === 'משכורת'));
  assert.ok(by['2026-08-28'].items.some((it) => it.name === 'לקוח א' && it.amount === 30000));
  // balance path: 20000 → 5000 on the 25th (dip) → 35000 on the 28th
  assert.equal(cf.dip.date, '2026-08-25');
  assert.equal(cf.dip.projected, 5000);
  assert.deepEqual(cf.dip.nextInflow, { date: '2026-08-28', amount: 30000 });
  assert.equal(cf.dip.belowWarn, true);
  assert.ok(cf.learned.length >= 3);
  assert.equal(shiftDate('2026-08-31', 1), '2026-09-01');
});

test('computeCashflow horizon 90 covers three occurrences of a monthly item', async (t) => {
  const { computeCashflow } = await import('../../lib/queries.js');
  const db = tmpDb(t, 'test-cashflow-90.db');
  db.prepare(`INSERT INTO accounts (id, provider, number, type, name, currency, balance) VALUES ('c','t','1','CHECKING','עו"ש','ILS', 100000)`).run();
  for (const m of ['05', '06', '07']) tx(db, `r${m}`, `2026-${m}-15`, -1000, 'מנוי', 'suppliers_other', 'expense');
  const cf = computeCashflow(db, '2026-08-01', 90);
  const hits = cf.days.filter((d) => d.items.some((it) => it.name === 'מנוי'));
  assert.deepEqual(hits.map((d) => d.date), ['2026-08-15', '2026-09-15', '2026-10-15']);
});

test('computeCashflow projects an every-other-month item only on its months', async (t) => {
  const { computeCashflow } = await import('../../lib/queries.js');
  const db = tmpDb(t, 'test-cashflow-bi.db');
  db.prepare(`INSERT INTO accounts (id, provider, number, type, name, currency, balance) VALUES ('c','t','1','CHECKING','עו"ש','ILS', 100000)`).run();
  for (const m of ['01', '03', '05', '07']) tx(db, `v${m}`, `2026-${m}-15`, -9000, 'מע"מ', 'tax_vat', 'expense');
  const cf = computeCashflow(db, '2026-08-01', 90);
  const hits = cf.days.filter((d) => d.items.some((it) => it.name === 'מע"מ')).map((d) => d.date);
  assert.deepEqual(hits, ['2026-09-15']);
});
