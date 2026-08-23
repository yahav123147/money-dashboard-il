// Fresh-install smoke: every compute* must run on an empty database without
// throwing. This is exactly what a new user hits in their first minute, and a
// build pass does not cover it — Next never executes the API at build time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertTx } from '../lib/db.mjs';
import {
  computePnl, computeExpenses, computeAdvances, computeFlags,
  computeOverview, computeCashflow, computeTaxView,
} from '../../lib/queries.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_DB = join(ROOT, 'data', 'test-smoke.db');

test('fresh install: every compute runs on an empty database', (t) => {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true });
  const db = openDb(TEST_DB);
  t.after(() => { db.close(); for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true }); });

  assert.deepEqual(computePnl(db).months, []);
  assert.ok(Array.isArray(computeExpenses(db).months));
  assert.ok(computeAdvances(db).month);
  assert.ok(Array.isArray(computeFlags(db)));
  assert.ok(computeOverview(db));
  assert.ok(computeCashflow(db));
  // businessRatio ships null; the view must degrade with a note, not throw.
  // An empty DB returns null (no complete months), which would make this check
  // vacuous — so seed ONE transaction in a past month and assert for real.
  // Must land in the CURRENT tax year and in a month that is already complete,
  // otherwise computeTaxView has nothing to work with. January is the one month
  // with no complete predecessor in its own tax year, so seed the current month
  // too and accept a null view there.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  const year = today.slice(0, 4);
  const seedMonth = `${year}-01`;
  upsertTx(db, {
    id: 'seed-1', account_id: 'a', account_number: '1', account_type: 'CHECKING',
    provider: 'p', date: `${seedMonth}-15`, month: seedMonth, amount: 1000,
    currency: 'ILS', counterparty: 'לקוח ראשון', raw_desc: 'העברה', status: 'completed',
    side: 'in', bucket: 'direct', bucket_group: 'revenue', raw_json: '{}',
  });
  const tax = computeTaxView(db);
  if (today.slice(5, 7) === '01') {
    assert.equal(tax, null, 'in January the tax year has no complete month yet');
  } else {
    assert.ok(tax, 'a month with data must produce a tax view');
    assert.ok(tax.cannotSize.notes.some((n) => n.includes('יחס המשרד')),
      'unset home-office ratio must surface as a note');
  }
});

test('demo seed lights every panel and stays deterministic', async (t) => {
  const { seedDemo, demoMonths } = await import('../demo-seed.mjs');
  // The demo follows the clock, so the assertions below must too. A literal
  // month here is the same bug the seeder just stopped having.
  const months = demoMonths(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()));
  const lastComplete = months[months.length - 2];
  const { computePnl, computeExpenses, computeTaxView, computeFlags, computeCashflow } =
    await import('../../lib/queries.js');
  const DB = join(ROOT, 'data', 'test-demo.db');
  for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
  const db = openDb(DB);
  t.after(() => { db.close(); for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true }); });

  const { rows } = seedDemo(db, 'murshe');
  assert.ok(rows > 150, 'a demo needs a real spread of transactions');

  const pnl = computePnl(db);
  assert.ok(pnl.months.length >= 7, 'eight months, one partial');
  assert.ok(pnl.months.every((m) => Number.isFinite(m.operating_profit)));
  // profitable but not absurd — a believable murshe
  const full = pnl.months.filter((m) => !m.partial);
  const margin = full.reduce((s, m) => s + m.operating_profit, 0) /
    full.reduce((s, m) => s + m.revenue_ex_vat, 0);
  assert.ok(margin > 0.1 && margin < 0.7, `margin ${margin} should look real`);

  // expense panel: several categories, and the calibration lesson (unclassified)
  const exp = computeExpenses(db);
  // computeExpenses only ever shows the current tax year, so assert on the
  // newest complete month it actually returns.
  const shown = exp.months.filter((m) => !m.partial);
  assert.ok(shown.length > 0, `the demo must leave at least one complete month in the tax year (window ${months[0]}..${lastComplete})`);
  const probe = shown[shown.length - 1];
  assert.ok(Object.values(probe.byCategory).filter((v) => v > 0).length >= 5);
  assert.ok(probe.byCategory.unclassified > 0, 'the unclassified teaching moment must exist');

  // tax bridge: non-null, with the home-office recognition actually firing
  const tax = computeTaxView(db, { entityType: 'murshe', creditPoints: 2.25, homeOfficeRatio: 0.3 });
  assert.ok(tax && tax.taxEstimate.high.nationalInsurance > 0);
  assert.ok(tax.adjustments.belowLineBusiness.some((x) => x.key === 'home_office'));

  // patur variant reaches the ceiling-warning zone
  const DB2 = join(ROOT, 'data', 'test-demo2.db');
  for (const s of ['', '-wal', '-shm']) rmSync(DB2 + s, { force: true });
  const db2 = openDb(DB2);
  t.after(() => { db2.close(); for (const s of ['', '-wal', '-shm']) rmSync(DB2 + s, { force: true }); });
  seedDemo(db2, 'patur');
  const flags = computeFlags(db2, { entityType: 'patur' });
  assert.ok(flags.some((f) => f.type === 'patur_ceiling'), 'patur demo must trigger the ceiling lesson');

  // cashflow has future movement to narrate
  assert.ok(computeCashflow(db).days.some((d) => d.items.length > 0));

  // determinism: same seed, same books — a recorded demo always matches a live one
  const DB3 = join(ROOT, 'data', 'test-demo3.db');
  for (const s of ['', '-wal', '-shm']) rmSync(DB3 + s, { force: true });
  const db3 = openDb(DB3);
  t.after(() => { db3.close(); for (const s of ['', '-wal', '-shm']) rmSync(DB3 + s, { force: true }); });
  seedDemo(db3, 'murshe');
  const total = (d) => d.prepare('SELECT ROUND(SUM(amount),2) s, COUNT(*) n FROM bank_transactions').get();
  assert.deepEqual(total(db3), total(db));
});
