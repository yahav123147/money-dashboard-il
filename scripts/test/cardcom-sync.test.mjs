// CardCom module: row mapping, sticky product names, range query, privacy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.mjs';
import { toRow, resolveProduct, toCardcomDate, CARDCOM_UPSERT_SQL } from '../cardcom-sync.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CFG = { enabled: true, productFieldId: 24, amountNames: { 199: 'מנוי חודשי' }, unknownLabel: 'אחר' };

function tmpDb(t, name) {
  const p = join(ROOT, 'data', name);
  for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true });
  const db = openDb(p);
  t.after(() => { db.close(); for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true }); });
  return db;
}

// A CardCom payload with the PII fields a real one carries. The row we keep
// must contain none of it. Fixture values are invented.
const TX = {
  TranzactionId: 12345, Amount: 490, CreateDate: '2026-03-04T10:15:00', IsRefund: false,
  CardOwnerName: 'פלוני אלמוני', CardOwnerEmail: 'someone@example.com', CardOwnerPhone: '0500000000',
  CustomFields: [{ Id: 24, Value: 'קורס דיגיטלי' }],
};

test('toRow keeps only deal id, time, amount and product', () => {
  const row = toRow(TX, CFG);
  assert.deepEqual(row, {
    deal_id: '12345', dt: '2026-03-04T10:15:00', date: '2026-03-04', amount: 490,
    product: 'קורס דיגיטלי', product_raw: 'קורס דיגיטלי', product_source: 'custom_field',
    acquirer: null, payments: 1, first_payment: null, const_payment: null,
  });
  const text = JSON.stringify(row);
  assert.ok(!text.includes('פלוני') && !text.includes('example.com') && !text.includes('0500000000'));
});

test('resolveProduct: custom field, then amount rule, then unknown label', () => {
  assert.equal(resolveProduct({ amount: 199, raw: 'X' }, CFG).source, 'custom_field');
  assert.deepEqual(resolveProduct({ amount: 199, raw: null }, CFG), { product: 'מנוי חודשי', source: 'amount_rule' });
  assert.deepEqual(resolveProduct({ amount: 77, raw: null }, CFG), { product: 'אחר', source: 'unknown' });
});

test('toCardcomDate is DDMMYYYY', () => {
  assert.equal(toCardcomDate('2026-03-04'), '04032026');
});

test('upsert never downgrades a resolved product to unknown', (t) => {
  const db = tmpDb(t, 'test-cardcom.db');
  const up = db.prepare(CARDCOM_UPSERT_SQL);
  up.run(toRow(TX, CFG));
  up.run(toRow({ ...TX, CustomFields: [] , Amount: 490 }, CFG)); // same deal, name missing this time
  const row = db.prepare('SELECT product, product_source FROM cardcom_sales WHERE deal_id=?').get('12345');
  assert.deepEqual(row, { product: 'קורס דיגיטלי', product_source: 'custom_field' });
});

test('computeSalesRange groups by product and by day, rejects bad ranges', async (t) => {
  const db = tmpDb(t, 'test-sales-range.db');
  const up = db.prepare(CARDCOM_UPSERT_SQL);
  up.run(toRow({ ...TX, TranzactionId: 1, CreateDate: '2026-03-04T09:00:00' }, CFG));
  up.run(toRow({ ...TX, TranzactionId: 2, CreateDate: '2026-03-04T11:00:00', Amount: 199, CustomFields: [] }, CFG));
  up.run(toRow({ ...TX, TranzactionId: 3, CreateDate: '2026-03-05T11:00:00' }, CFG));
  const { computeSalesRange } = await import('../../lib/queries.js');
  const r = computeSalesRange(db, '2026-03-04', '2026-03-05');
  assert.equal(r.total, 490 + 199 + 490);
  assert.equal(r.count, 3);
  assert.equal(r.byProduct['קורס דיגיטלי'].count, 2);
  assert.deepEqual(r.days.map((d) => d.total), [689, 490]);
  const one = computeSalesRange(db, '2026-03-05', '2026-03-05');
  assert.equal(one.count, 1);
  assert.throws(() => computeSalesRange(db, '2026-03-06', '2026-03-05'));
  assert.throws(() => computeSalesRange(db, 'x', '2026-03-05'));
});

test('config/cardcom.json ships disabled with an empty amount map', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'cardcom.json'), 'utf8'));
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.amountNames, {});
});
