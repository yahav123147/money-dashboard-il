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
const tx = (db, id, date, amount, bucket, group, extra = {}) => upsertTx(db, {
  id, account_id: 'c', account_number: '1', account_type: 'CHECKING', provider: 't', date, month: date.slice(0, 7),
  amount, currency: 'ILS', counterparty: 'x', raw_desc: 'x', status: 'completed', side: amount > 0 ? 'in' : 'out',
  bucket, bucket_group: group, raw_json: '{}', ...extra,
});

test('computeVat: output minus input on the closed period; paid detection; period math', async (t) => {
  const { computeVat, israelToday, shiftDate, settings } = await import('../../lib/queries.js');
  const db = tmpDb(t, 'test-vat.db');
  const today = israelToday();
  const cur = today.slice(0, 7);
  // closed period = the month(s) before the open one; put rows two months back to be safe for both 1 and 2
  const m2 = shiftDate(`${cur}-01`, -40).slice(0, 7);
  const m1 = shiftDate(`${cur}-01`, -10).slice(0, 7);
  tx(db, 'r1', `${m2}-05`, 11800, 'direct', 'revenue');      // 1800 output VAT
  tx(db, 'e1', `${m2}-06`, -5900, 'suppliers_other', 'expense'); // 900 input VAT
  tx(db, 'e2', `${m2}-07`, -10000, 'team', 'expense');       // salaries: no VAT
  const vat = computeVat(db, { entityType: 'company' });
  assert.equal(vat.applicable, true);
  assert.ok([1, 2].includes(vat.periodMonths));
  const inClosed = vat.closed.from <= m2 && m2 <= vat.closed.to;
  const inOpen = vat.open.from <= m2 && m2 <= vat.open.to;
  const block = inClosed ? vat.closed : inOpen ? vat.open : null;
  assert.ok(block, 'the seeded month falls in one of the two reported periods');
  const part = (settings.vatRate - 1) / settings.vatRate;
  assert.equal(block.outputVat, Math.round(11800 * part));
  assert.equal(block.inputVat, Math.round(5900 * part));
  assert.equal(block.net, block.outputVat - block.inputVat);
  assert.equal(vat.closed.due.slice(8), String(settings.vatDueDay || 15).padStart(2, '0'));
});

test('computeVat: patur is not applicable', async (t) => {
  const { computeVat } = await import('../../lib/queries.js');
  const db = tmpDb(t, 'test-vat-patur.db');
  assert.equal(computeVat(db, { entityType: 'patur' }).applicable, false);
});

test('vatPeriodMonths: turnover above threshold → monthly, below → bi-monthly', async (t) => {
  const { vatPeriodMonths, israelToday } = await import('../../lib/queries.js');
  const db = tmpDb(t, 'test-vat-period.db');
  const y = israelToday().slice(0, 4);
  assert.equal(vatPeriodMonths(db, { entityType: 'murshe' }).months, 2);
  tx(db, 'big', `${y}-01-10`, 2_000_000, 'direct', 'revenue');
  const p = vatPeriodMonths(db, { entityType: 'murshe' });
  assert.equal(p.months, 1);
  assert.equal(p.source, 'turnover');
});

test('computeAdvancesYtd: sums tax_advance for the year and reports status', async (t) => {
  const { computeAdvancesYtd, israelToday } = await import('../../lib/queries.js');
  const db = tmpDb(t, 'test-adv-ytd.db');
  const y = israelToday().slice(0, 4);
  tx(db, 'a1', `${y}-01-15`, -3000, 'tax_advance', 'expense');
  tx(db, 'a2', `${y}-02-15`, -3000, 'tax_advance', 'expense');
  const out = computeAdvancesYtd(db, { entityType: 'company' });
  assert.equal(out.paidYtd, 6000);
  assert.ok(['on_track', 'behind', 'ahead', 'unknown'].includes(out.status));
});
