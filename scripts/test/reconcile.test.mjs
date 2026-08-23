import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, isSettlementCredit, shiftIso } from '../lib/reconcile.mjs';

const TODAY = '2026-03-20';
const credit = (id, date, amount, desc = 'זיכוי קארדקום') => ({ id, date, amount, counterparty: desc, raw_desc: desc });

test('daily: matched within tolerance, partial beyond, missing after window, pending inside it', () => {
  const sales = [
    { date: '2026-03-01', total: 1000 }, // lands 03-02 at 988 → matched (1.2% fee)
    { date: '2026-03-02', total: 2000 }, // lands 03-03 at 1500 → partial
    { date: '2026-03-03', total: 500 },  // nothing → missing (window closed 03-08)
    { date: '2026-03-18', total: 700 },  // nothing yet → pending (window to 03-23)
  ];
  const credits = [credit('a', '2026-03-02', 988), credit('b', '2026-03-03', 1500)];
  const out = reconcile({ sales, credits, settlement: { feePct: 1.2, tolerancePct: 2 }, today: TODAY });
  const by = Object.fromEntries(out.rows.map((x) => [x.key, x]));
  assert.equal(by['2026-03-01'].status, 'matched');
  assert.equal(by['2026-03-01'].expected, 988);
  assert.equal(by['2026-03-02'].status, 'partial');
  assert.equal(by['2026-03-02'].diff, 1500 - 1976);
  assert.equal(by['2026-03-03'].status, 'missing');
  assert.equal(by['2026-03-18'].status, 'pending');
  assert.deepEqual(out.summary, { matched: 1, partial: 1, missing: 1, pending: 1, missingAmount: 494, diffAmount: -476 });
  assert.equal(out.rows[0].key, '2026-03-18', 'newest first');
});

test('daily: picks the closest credit and never reuses one', () => {
  const sales = [{ date: '2026-03-01', total: 1000 }, { date: '2026-03-02', total: 1000 }];
  const credits = [credit('x', '2026-03-03', 1000), credit('y', '2026-03-03', 400)];
  const out = reconcile({ sales, credits, settlement: { feePct: 0 }, today: TODAY });
  const by = Object.fromEntries(out.rows.map((x) => [x.key, x]));
  assert.equal(by['2026-03-01'].credits[0].id, 'x');
  assert.equal(by['2026-03-02'].credits[0].id, 'y');
  assert.equal(by['2026-03-02'].status, 'partial');
  assert.equal(out.unmatchedCredits.length, 0);
});

test('monthly: sums credits in the following month; unmatched credits are listed', () => {
  const sales = [{ date: '2026-01-05', total: 3000 }, { date: '2026-01-20', total: 2000 }];
  const credits = [credit('m1', '2026-02-10', 3000), credit('m2', '2026-02-11', 2000), credit('z', '2026-03-01', 999)];
  const out = reconcile({ sales, credits, settlement: { mode: 'monthly', feePct: 0 }, today: TODAY });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].label, '2026-01');
  assert.equal(out.rows[0].status, 'matched');
  assert.equal(out.rows[0].received, 5000);
  assert.deepEqual(out.unmatchedCredits.map((c) => c.id), ['z']);
});

test('monthly with dayOfMonth: only credits near the anchor count', () => {
  const sales = [{ date: '2026-01-05', total: 1000 }];
  const credits = [credit('far', '2026-02-01', 1000), credit('near', '2026-02-16', 1000)];
  const out = reconcile({ sales, credits, settlement: { mode: 'monthly', dayOfMonth: 15, feePct: 0 }, today: TODAY });
  assert.deepEqual(out.rows[0].credits.map((c) => c.id), ['near']);
});

test('isSettlementCredit: positive amount + keyword, case-insensitive, either field', () => {
  const kw = ['קארדקום', 'CARDCOM', 'ישראכרט'];
  assert.ok(isSettlementCredit({ amount: 10, counterparty: 'זיכוי קארדקום' }, kw));
  assert.ok(isSettlementCredit({ amount: 10, raw_desc: 'cardcom ltd' }, kw));
  assert.ok(!isSettlementCredit({ amount: -10, counterparty: 'קארדקום' }, kw), 'debits are not settlements');
  assert.ok(!isSettlementCredit({ amount: 10, counterparty: 'שכר דירה' }, kw));
});

test('shiftIso crosses month ends', () => {
  assert.equal(shiftIso('2026-01-31', 1), '2026-02-01');
  assert.equal(shiftIso('2026-03-01', -1), '2026-02-28');
});

test('a day with no credit does not steal the next day\'s credit', () => {
  const sales = [{ date: '2026-03-01', total: 1000 }, { date: '2026-03-02', total: 2000 }];
  const credits = [credit('only', '2026-03-03', 2000)]; // belongs to 03-02
  const out = reconcile({ sales, credits, settlement: { feePct: 0 }, today: TODAY });
  const by = Object.fromEntries(out.rows.map((x) => [x.key, x]));
  assert.equal(by['2026-03-02'].status, 'matched');
  assert.equal(by['2026-03-01'].status, 'missing');
});
