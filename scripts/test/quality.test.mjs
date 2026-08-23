import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertTx } from '../lib/db.mjs';
import * as Q from '../lib/quality.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
function tmpDb(t, name) {
  const p = join(ROOT, 'data', name);
  for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true });
  const db = openDb(p);
  t.after(() => { db.close(); for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true }); });
  return db;
}
const tx = (db, id, date, amount, counterparty, bucket, group, status = 'completed') => upsertTx(db, {
  id, account_id: 'c', account_number: '1', account_type: 'CHECKING', provider: 't', date, month: date.slice(0, 7),
  amount, currency: 'ILS', counterparty, raw_desc: counterparty, status, side: amount > 0 ? 'in' : 'out',
  bucket, bucket_group: group, raw_json: '{}',
});

test('checkRecurringDuplicates: manual + learned on the same day and amount, no shared bucket → fix', () => {
  const out = Q.checkRecurringDuplicates({
    manual: [{ name: 'שכר דירה', day: 1, amount: -4500 }],
    learned: [{ name: 'נכסים בע"מ', day: 2, amount: -4400, bucket: 'rent' }, { name: 'חשמל', day: 10, amount: -700, bucket: 'utilities' }],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'fix');
  assert.match(out[0].text, /שכר דירה/);
});

test('checkRecurringDuplicates: shared bucket is already deduped → nothing', () => {
  const out = Q.checkRecurringDuplicates({
    manual: [{ name: 'שכר דירה', day: 1, amount: -4500, bucket: 'rent' }],
    learned: [{ name: 'נכסים בע"מ', day: 2, amount: -4400, bucket: 'rent' }],
  });
  assert.equal(out.length, 0);
});

test('checkRecurringDuplicates: both classified into different buckets → different payments, nothing', () => {
  const out = Q.checkRecurringDuplicates({
    manual: [{ name: 'ביטוח לאומי', day: 23, amount: -13500, bucket: 'tax_social' }],
    learned: [{ name: 'ניכויים', day: 20, amount: -15900, bucket: 'tax_withholding' }],
  });
  assert.equal(out.length, 0);
});

test('checkStaleManual: manual item unseen by name or bucket for 3 months → warn', () => {
  const out = Q.checkStaleManual({
    manual: [{ name: 'ביטוח ישן', day: 5, amount: -300 }, { name: 'חשמל', day: 10, amount: -700, bucket: 'utilities' }],
    seenNames: new Set(['חשמל']), seenBuckets: new Set(['utilities']),
  });
  assert.equal(out.length, 1);
  assert.match(out[0].key, /ביטוח ישן/);
});

test('checkAcquirersNeverLand: expected but never received over 2+ periods → info', () => {
  const out = Q.checkAcquirersNeverLand({ byAcquirer: { cardcom: { expected: 100000, received: 98000, periods: 4 }, paypal: { expected: 9000, received: 0, periods: 3 } }, labels: (k) => k });
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'info');
  assert.match(out[0].key, /paypal/);
});

test('checkTaxDebitDays: bank says ~27, settings say 15 → warn with suggested value', () => {
  const out = Q.checkTaxDebitDays({ vatDays: [27, 26, 28, 27], advanceDays: [15, 16], vatDueDay: 15, advanceDueDay: 15 });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].suggested, { setting: 'vatDueDay', value: 27 });
});

test('checkVatEstimate: paid ≈ computed → nothing; paid 3x computed → warn', () => {
  assert.equal(Q.checkVatEstimate({ periods: [{ net: 10000, paid: 9500 }, { net: 12000, paid: 13000 }] }).length, 0);
  const out = Q.checkVatEstimate({ periods: [{ net: 10000, paid: 30000 }, { net: 12000, paid: 35000 }] });
  assert.equal(out.length, 1);
  assert.match(out[0].text, /גבוה/);
});

test('checkUnclassifiedShare: 30% unclassified → fix; 5% → nothing', () => {
  assert.equal(Q.checkUnclassifiedShare({ unclassified: 30000, total: 100000, count: 12 })[0].severity, 'fix');
  assert.equal(Q.checkUnclassifiedShare({ unclassified: 5000, total: 100000, count: 2 }).length, 0);
});

test('summarizeQuality: a cashflow fix → confidence low, verdict fix', () => {
  const s = Q.summarizeQuality([{ severity: 'fix', area: 'cashflow' }, { severity: 'info', area: 'sales' }]);
  assert.equal(s.verdict, 'fix'); assert.equal(s.confidence, 'low'); assert.equal(s.counts.info, 1);
  assert.equal(Q.summarizeQuality([]).confidence, 'high');
});

test('computeQuality on a db: duplicate pending rows, stale bank, unclassified share, manual duplicate', async (t) => {
  const { computeQuality } = await import('../../lib/queries.js');
  const db = tmpDb(t, 'test-quality.db');
  const today = '2026-08-10';
  // learned rent on the 25th
  for (const m of ['04', '05', '06', '07']) tx(db, `r${m}`, `2026-${m}-25`, -15000, 'נכסים', 'rent', 'expense');
  // unclassified 40% of last 3 months
  tx(db, 'u1', '2026-07-03', -10000, 'לא ידוע', null, 'unclassified');
  // duplicate pending rows
  tx(db, 'p1', '2026-08-20', -2000, 'ספק', 'software', 'expense', 'PENDING');
  tx(db, 'p2', '2026-08-20', -2000, 'ספק', 'software', 'expense', 'PENDING');
  // manual recurring that duplicates the learned rent (no bucket)
  const recPath = join(ROOT, 'config', 'recurring.json');
  const orig = readFileSync(recPath, 'utf8');
  const cfg = JSON.parse(orig);
  writeFileSync(recPath, JSON.stringify({ ...cfg, items: [{ name: 'שכירות משרד', day: 26, amount: -15000 }] }));
  t.after(() => writeFileSync(recPath, orig));
  await new Promise((res) => setTimeout(res, 20));

  const q = computeQuality(db, today);
  const keys = q.findings.map((f) => f.key);
  assert.ok(keys.some((k) => k.startsWith('rec_dup|')), 'manual/learned duplicate');
  assert.ok(keys.includes('pending_dupes'), 'pending duplicates');
  assert.ok(keys.includes('unclassified_share'), 'unclassified share');
  assert.ok(keys.includes('bank_stale'), 'bank last row 07-03 vs today 08-10');
  assert.equal(q.confidence, 'low');
  assert.equal(q.findings[0].severity, 'fix', 'sorted fix first');
});
