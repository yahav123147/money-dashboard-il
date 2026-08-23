import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, isSettlementCredit, shiftIso, scheduleFor } from '../lib/reconcile.mjs';

const TODAY = '2026-03-20';
const credit = (id, date, amount, desc = 'זיכוי קארדקום') => ({ id, date, amount, counterparty: desc, raw_desc: desc });
const sale = (date, amount, extra = {}) => ({ date, amount, ...extra });

test('daily: matched within tolerance, partial beyond, missing after window, pending inside it', () => {
  const sales = [sale('2026-03-01', 1000), sale('2026-03-02', 2000), sale('2026-03-03', 500), sale('2026-03-18', 700)];
  const credits = [credit('a', '2026-03-02', 988), credit('b', '2026-03-03', 1500)];
  const out = reconcile({ sales, credits, settlement: { feePct: 1.2, tolerancePct: 2 }, today: TODAY });
  const by = Object.fromEntries(out.rows.map((x) => [x.label, x]));
  assert.equal(by['2026-03-02'].status, 'matched');
  assert.equal(by['2026-03-02'].expected, 988);
  assert.equal(by['2026-03-03'].status, 'partial');
  assert.equal(by['2026-03-04'].status, 'missing');
  assert.equal(by['2026-03-19'].status, 'pending');
  assert.equal(out.summary.missingAmount, 494);
});

test('a day with no credit does not steal the next day\'s credit', () => {
  const sales = [sale('2026-03-01', 1000), sale('2026-03-02', 2000)];
  const credits = [credit('only', '2026-03-03', 2000)];
  const out = reconcile({ sales, credits, settlement: { feePct: 0 }, today: TODAY });
  const by = Object.fromEntries(out.rows.map((x) => [x.label, x]));
  assert.equal(by['2026-03-03'].status, 'matched');
  assert.equal(by['2026-03-02'].status, 'missing');
});

test('installments are expected one per month, not all at once', () => {
  const s = scheduleFor({ date: '2026-01-10', amount: 3000, payments: 3, firstPayment: 1000, constPayment: 1000 }, 1);
  assert.deepEqual(s, [{ date: '2026-01-11', amount: 1000 }, { date: '2026-02-11', amount: 1000 }, { date: '2026-03-11', amount: 1000 }]);
  // monthly settler: January sale → February, March, April payouts
  assert.deepEqual(scheduleFor({ date: '2026-01-10', amount: 3000, payments: 3, firstPayment: 1000, constPayment: 1000 }, 1, 'monthly').map((x) => x.date.slice(0, 7)), ['2026-02', '2026-03', '2026-04']);
  const sales = [sale('2026-01-10', 3000, { payments: 3, firstPayment: 1000, constPayment: 1000 })];
  const credits = [credit('f', '2026-02-15', 1000), credit('m', '2026-03-02', 1000)];
  const out = reconcile({ sales, credits, settlement: { mode: 'monthly', feePct: 0 }, today: '2026-03-05' });
  const by = Object.fromEntries(out.rows.map((x) => [x.label, x]));
  assert.equal(by['2026-02'].expected, 1000);
  assert.equal(by['2026-02'].status, 'matched');
  assert.equal(by['2026-03'].status, 'matched');
  assert.equal(by['2026-03'].fromInstallments, 1000);
  assert.equal(by['2026-04'], undefined, 'April is beyond the horizon');
});

test('monthly: sums credits in the landing month; more than scheduled is fine; other acquirers reconciled alone', () => {
  const sales = [
    sale('2026-01-05', 3000), sale('2026-01-20', 2000),
    sale('2026-01-22', 900, { acquirer: 'PayPal' }),
  ];
  const credits = [credit('m1', '2026-02-10', 3000), credit('m2', '2026-02-11', 2600), credit('z', '2026-03-01', 999)];
  const out = reconcile({ sales, credits, settlement: { mode: 'monthly', feePct: 0, acquirers: { PayPal: { keywords: ['paypal'] } } }, today: TODAY });
  const cc = out.rows.find((x) => x.acquirer === 'CardCom' && x.label === '2026-02');
  assert.equal(cc.status, 'matched');
  assert.equal(cc.received, 5600);
  const pp = out.rows.find((x) => x.acquirer === 'PayPal');
  assert.equal(pp.status, 'missing');
  assert.equal(out.byAcquirer.PayPal.missing, 900);
  assert.deepEqual(out.unmatchedCredits.map((c) => c.id), ['z']);
});

test('monthly with dayOfMonth: only credits near the anchor count', () => {
  const sales = [sale('2026-01-05', 1000)];
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
