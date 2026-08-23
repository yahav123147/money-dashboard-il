// Every expected figure here was derived BY HAND from config/tax-brackets.json
// (2026) before the engine existed, then cross-checked in a standalone node
// calculation. If a bracket changes in config, these literals must be re-derived
// — that is intentional: the tests pin the 2026 figures the file claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTax, bracketIncomeTax, selfEmployedBtlMonthly } from '../lib/tax-engines.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CFG = JSON.parse(readFileSync(join(ROOT, 'config', 'tax-brackets.json'), 'utf8'));

test('bracket income tax — exact boundary and mid-bracket values', () => {
  // 84,120 is exactly the top of the 10% bracket
  assert.equal(bracketIncomeTax(84120, CFG), 8412);
  // 120,720 = 8,412 + 36,600 × 14%
  assert.equal(bracketIncomeTax(120720, CFG), 13536);
  // 300,000 = 8,412 + 5,124 + 107,280×20% + 72,000×31%
  assert.equal(bracketIncomeTax(300000, CFG), 57312);
  // 800,000 crosses the surtax line: base 224,163.6 + 78,440×3% surtax
  assert.equal(Math.round(bracketIncomeTax(800000, CFG)), 263384);
  assert.equal(bracketIncomeTax(0, CFG), 0);
  assert.equal(bracketIncomeTax(-5000, CFG), 0);
});

test('self-employed national insurance — reduced tier, full tier, floor, ceiling', () => {
  // 20,000/month: 7,703×7.70% + 12,297×18% = 593.13 + 2,213.46
  assert.equal(Math.round(selfEmployedBtlMonthly(20000, CFG).combined * 100) / 100, 2806.59);
  // below the floor: charged as if earning 3,442 → 3,442×7.70%
  assert.equal(Math.round(selfEmployedBtlMonthly(2000, CFG).combined * 100) / 100, 265.03);
  // above the ceiling: capped at 51,910
  assert.equal(Math.round(selfEmployedBtlMonthly(60000, CFG).combined * 100) / 100, 8550.39);
  // zero income: nothing due (the floor applies to earners, not to zero)
  assert.equal(selfEmployedBtlMonthly(0, CFG).combined, 0);
  // the NI/health split must sum to the combined figure
  const b = selfEmployedBtlMonthly(20000, CFG);
  assert.ok(Math.abs(b.nationalInsurance + b.healthInsurance - b.combined) < 0.01);
});

test('estimateTax: company is flat corporate rate, no BTL', () => {
  const e = estimateTax('company', 1000000, CFG, {});
  assert.equal(e.incomeTax, 230000);
  assert.equal(e.nationalInsurance, 0);
  assert.equal(e.healthInsurance, 0);
  assert.equal(e.total, 230000);
});

test('estimateTax: individual gets brackets minus credits plus BTL', () => {
  // 240,000/year (20,000/month), explicit 2.25 credit points
  const e = estimateTax('murshe', 240000, CFG, { creditPoints: 2.25 });
  // brackets: 8,412 + 5,124 + (228,000-120,720)×20% + 12,000×31% = 38,712
  // credits: 2.25 × 2,904 = 6,534 → 32,178
  assert.equal(e.incomeTax, 32178);
  // BTL: 2,806.59 × 12 = 33,679.08
  assert.equal(Math.round(e.nationalInsurance + e.healthInsurance), 33679);
  assert.equal(e.total, e.incomeTax + e.nationalInsurance + e.healthInsurance);
  // for a murshe at this income, BTL exceeds income tax — the whole reason
  // the individual engine exists
  assert.ok(e.nationalInsurance + e.healthInsurance > e.incomeTax);
});

test('estimateTax: credits cannot push income tax below zero', () => {
  const e = estimateTax('patur', 30000, CFG, { creditPoints: 2.25 });
  // brackets on 30,000 = 3,000; credits 6,534 → clamped to 0, not negative
  assert.equal(e.incomeTax, 0);
  assert.ok(e.notes.some((n) => n.includes('נקודות הזיכוי')));
});

test('estimateTax: null creditPoints falls back to the resident minimum, with a note', () => {
  const e = estimateTax('murshe', 240000, CFG, { creditPoints: null });
  assert.equal(e.incomeTax, 32178); // same as explicit 2.25
  assert.ok(e.notes.some((n) => n.includes('2.25')));
});

test('estimateTax: patur and murshe use the identical individual engine', () => {
  const a = estimateTax('patur', 200000, CFG, { creditPoints: 3 });
  const b = estimateTax('murshe', 200000, CFG, { creditPoints: 3 });
  assert.deepEqual(a.incomeTax, b.incomeTax);
  assert.deepEqual(a.combinedBtl, b.combinedBtl);
});

test('estimateTax: the omitted BTL deduction is declared, not silent', () => {
  // section 47א (52% of NI deductible from taxable income) is deliberately NOT
  // implemented — unresearched figures stay out of the code. The estimate must
  // SAY so: it overstates tax slightly, which is the safe direction.
  const e = estimateTax('murshe', 240000, CFG, { creditPoints: 2.25 });
  assert.ok(e.notes.some((n) => n.includes('47א')));
});

test('integration: the advance-rate recommendation actually depends on the entity', async () => {
  const { rmSync } = await import('node:fs');
  const { openDb, upsertTx } = await import('../lib/db.mjs');
  const { computeTaxView, computeAdvances } = await import('../../lib/queries.js');
  const DB = join(ROOT, 'data', 'test-entity.db');
  for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
  const db = openDb(DB);
  try {
    // one complete month: ₪100,000 revenue in, ₪40,000 team expense out
    upsertTx(db, { id: 'e1', account_id: 'a', account_number: '1', account_type: 'CHECKING',
      provider: 'p', date: '2026-01-10', month: '2026-01', amount: 100000, currency: 'ILS',
      counterparty: 'לקוח', raw_desc: 'העברה', status: 'completed', side: 'in',
      bucket: 'direct', bucket_group: 'revenue', raw_json: '{}' });
    upsertTx(db, { id: 'e2', account_id: 'a', account_number: '1', account_type: 'CHECKING',
      provider: 'p', date: '2026-01-15', month: '2026-01', amount: -40000, currency: 'ILS',
      counterparty: 'עובד', raw_desc: 'שכר', status: 'completed', side: 'out',
      bucket: 'team', bucket_group: 'expense', raw_json: '{}' });

    const company = computeTaxView(db, { entityType: 'company' });
    const murshe = computeTaxView(db, { entityType: 'murshe', creditPoints: 2.25 });

    // same books, different entity → different implied advance rate
    assert.notEqual(company.impliedRatePct.high, murshe.impliedRatePct.high);
    // company: no BTL. individual: BTL present and reported separately
    assert.equal(company.taxEstimate.high.nationalInsurance, 0);
    assert.ok(murshe.taxEstimate.high.nationalInsurance > 0);
    // the individual engine must NOT fold BTL into the advance rate:
    // rate*turnover ≈ income tax alone, well below income tax + BTL
    const t = murshe.turnoverExVat;
    const impliedTax = (murshe.impliedRatePct.high / 100) * t;
    assert.ok(Math.abs(impliedTax - murshe.taxEstimate.high.incomeTax) < t * 0.002,
      'advance rate must reflect income tax only');

    // computeAdvances honours the same override
    const advCompany = computeAdvances(db, '2026-01', { entityType: 'company' });
    const advMurshe = computeAdvances(db, '2026-01', { entityType: 'murshe', creditPoints: 2.25 });
    assert.notEqual(advCompany.requiredRatePct, advMurshe.requiredRatePct);
  } finally {
    db.close();
    for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
  }
});

test('patur turnover ceiling: warns at 80%, alarms past 100%, silent for others', async () => {
  const { rmSync } = await import('node:fs');
  const { openDb, upsertTx } = await import('../lib/db.mjs');
  const { computeFlags } = await import('../../lib/queries.js');
  const DB = join(ROOT, 'data', 'test-ceiling.db');
  const mk = (total, id) => {
    upsertTx(db, { id, account_id: 'a', account_number: '1', account_type: 'CHECKING',
      provider: 'p', date: '2026-02-10', month: '2026-02', amount: total, currency: 'ILS',
      counterparty: 'לקוח', raw_desc: 'העברה', status: 'completed', side: 'in',
      bucket: 'direct', bucket_group: 'revenue', raw_json: '{}' });
  };
  for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
  let db = openDb(DB);
  try {
    // 110,000 of the 122,833 ceiling = 89.55% → rounds to 90% → medium warning
    mk(110000, 'c1');
    const warn = computeFlags(db, { entityType: 'patur' });
    const w = warn.find((f) => f.type === 'patur_ceiling');
    assert.ok(w, 'must flag at 90% of the ceiling');
    assert.equal(w.severity, 'medium');
    assert.ok(w.text.includes('90%'));

    // push past 100% → high severity, says exceeded
    mk(20000, 'c2');
    const over = computeFlags(db, { entityType: 'patur' });
    const o = over.find((f) => f.type === 'patur_ceiling');
    assert.equal(o.severity, 'high');
    assert.ok(o.text.includes('חרגת'));

    // same turnover, other entities → no such flag
    assert.ok(!computeFlags(db, { entityType: 'murshe' }).some((f) => f.type === 'patur_ceiling'));
    assert.ok(!computeFlags(db, { entityType: 'company' }).some((f) => f.type === 'patur_ceiling'));
    assert.ok(!computeFlags(db, {}).some((f) => f.type === 'patur_ceiling'));
  } finally {
    db.close();
    for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
  }
});
