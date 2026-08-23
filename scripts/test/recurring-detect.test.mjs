import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRecurring, normalizeName, shiftMonth } from '../lib/recurring-detect.mjs';

const TODAY = '2026-08-23';
const rows = [];
const add = (date, amount, counterparty, bucket = 'suppliers_other') => rows.push({ date, amount, counterparty, bucket });

// rent: 6 months, day 1, stable → recurring
for (const m of ['03', '04', '05', '06', '07', '08']) add(`2026-${m}-01`, -4500, 'שכירות משרד 1234', 'rent');
// salary: 5 months, days 5-8, ±10% → recurring
add('2026-04-05', -12000, 'משכורת', 'team'); add('2026-05-07', -12500, 'משכורת', 'team');
add('2026-06-06', -11800, 'משכורת', 'team'); add('2026-07-08', -12100, 'משכורת', 'team'); add('2026-08-05', -12300, 'משכורת', 'team');
// retainer inflow: 4 months, day 10 → recurring (positive)
for (const m of ['05', '06', '07', '08']) add(`2026-${m}-10`, 8000, 'לקוח ריטיינר בע"מ', 'direct');
// one-offs: same vendor, wildly different amounts → not recurring
add('2026-06-12', -300, 'חנות ציוד'); add('2026-07-03', -4100, 'חנות ציוד'); add('2026-08-20', -90, 'חנות ציוד');
// old: stopped 3 months ago → not recurring
for (const m of ['02', '03', '04']) add(`2026-${m}-15`, -900, 'מנוי ישן');
// only two months → not enough
add('2026-07-20', -250, 'חדש'); add('2026-08-20', -250, 'חדש');

test('detectRecurring finds stable monthly movements in both directions', () => {
  const out = detectRecurring(rows, { today: TODAY });
  const names = out.map((x) => normalizeName(x.name));
  assert.ok(names.includes('שכירות משרד'));
  assert.ok(names.includes('משכורת'));
  assert.ok(names.includes('לקוח ריטיינר בע"מ'));
  assert.ok(!names.includes('חנות ציוד'));
  assert.ok(!names.includes('מנוי ישן'));
  assert.ok(!names.includes('חדש'));
  const rent = out.find((x) => x.bucket === 'rent');
  assert.equal(rent.day, 1);
  assert.equal(rent.amount, -4500);
  assert.equal(rent.months, 6);
  const salary = out.find((x) => x.bucket === 'team');
  assert.ok(salary.day >= 5 && salary.day <= 7);
  assert.ok(Math.abs(salary.amount + 12100) < 300);
});

test('normalizeName strips reference numbers so variants group together', () => {
  assert.equal(normalizeName('העברה 1234 חברת X'), normalizeName('העברה 5678 חברת X'));
});

test('shiftMonth crosses years', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-08', -5), '2026-03');
});

test('bi-monthly cadence is detected and carried as every=2', () => {
  const r2 = [];
  for (const m of ['01', '03', '05', '07']) r2.push({ date: `2026-${m}-15`, amount: -9000, counterparty: 'מע"מ', bucket: 'tax_vat' });
  const out = detectRecurring(r2, { today: TODAY });
  assert.equal(out.length, 1);
  assert.equal(out[0].every, 2);
  assert.equal(out[0].anchorMonth, '2026-07');
});
