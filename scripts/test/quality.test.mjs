import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
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

test('checkTaxDebitDays: VAT landing late is a warning, never a suggestion to move the legal date; advances day is a setting', () => {
  const out = Q.checkTaxDebitDays({ vatDays: [27, 26, 28, 27], advanceDays: [15, 16], vatDueDay: 15, advanceDueDay: 15 });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'tax_day|vat_late'); assert.equal(out[0].suggested, undefined);
  const adv = Q.checkTaxDebitDays({ vatDays: [], advanceDays: [27, 28, 27], vatDueDay: 15, advanceDueDay: 15 });
  assert.deepEqual(adv[0].suggested, { setting: 'advanceDueDay', value: 27 });
  // VAT debited a little before the legal date is fine
  assert.equal(Q.checkTaxDebitDays({ vatDays: [12, 13, 14], advanceDays: [], vatDueDay: 15, advanceDueDay: 15 }).length, 0);
});

test('checkFreshness: from the last successful sync, not the last transaction', () => {
  const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  assert.equal(Q.checkFreshness({ today: '2026-08-10', bankLastSync: '2026-08-10 04:00:00', daysBetween }).length, 0, 'quiet account synced today is fresh');
  assert.equal(Q.checkFreshness({ today: '2026-08-10', bankLastSync: null, daysBetween })[0].key, 'bank_never_synced', 'an empty db that never synced is not a clean account');
  assert.equal(Q.checkFreshness({ today: '2026-08-10', bankLastSync: '2026-08-01 04:00:00', daysBetween })[0].key, 'bank_stale');
  const cc = Q.checkFreshness({ today: '2026-08-10', bankLastSync: '2026-08-10 04:00:00', cardcomEnabled: true, cardcomLastSync: null, daysBetween });
  assert.equal(cc[0].key, 'cardcom_never_synced'); assert.equal(cc[0].area, 'cashflow');
  assert.equal(Q.summarizeQuality(cc).confidence, 'medium', 'missing settlement data is not a high-confidence forecast');
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
  assert.equal(Q.summarizeQuality([{ severity: 'fix', area: 'general' }]).confidence, 'low', 'a stale bank is never a high-confidence forecast');
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
  // manual recurring that duplicates the learned rent (no bucket), passed in
  // memory: the test never touches config/recurring.json
  const recurringFixture = { items: [{ name: 'שכירות משרד', day: 26, amount: -15000 }], ignore: [] };

  const q = computeQuality(db, today, { recurring: recurringFixture });
  const keys = q.findings.map((f) => f.key);
  assert.ok(keys.some((k) => k.startsWith('rec_dup|')), 'manual/learned duplicate');
  assert.ok(keys.includes('pending_dupes'), 'pending duplicates');
  assert.ok(keys.includes('unclassified_share'), 'unclassified share');
  assert.ok(keys.includes('bank_never_synced'), 'rows exist but no successful sync logged');
  assert.equal(q.confidence, 'low');
  assert.equal(q.findings[0].severity, 'fix', 'sorted fix first');
});

test('computeQuality on an empty db that never synced: never good/high', async (t) => {
  const { computeQuality } = await import('../../lib/queries.js');
  const db = tmpDb(t, 'test-quality-empty.db');
  const q = computeQuality(db, '2026-08-10', { recurring: { items: [], ignore: [] } });
  assert.equal(q.confidence, 'low');
  assert.ok(q.findings.some((f) => f.key === 'bank_never_synced'));
});

test('computeQuality ignores financy_refresh: a refresh is not a sync', async (t) => {
  const { computeQuality } = await import('../../lib/queries.js');
  const db = tmpDb(t, 'test-quality-refresh.db');
  db.prepare(`INSERT INTO sync_log (source, ts, ok, note) VALUES ('financy', '2026-07-20 04:00:00', 1, '')`).run();
  db.prepare(`INSERT INTO sync_log (source, ts, ok, note) VALUES ('financy_refresh', '2026-08-10 04:00:00', 1, '')`).run();
  db.prepare(`INSERT INTO sync_log (source, ts, ok, note) VALUES ('financy', '2026-08-10 04:01:00', 0, 'failed')`).run();
  const q = computeQuality(db, '2026-08-10', { recurring: { items: [], ignore: [] } });
  assert.ok(q.findings.some((f) => f.key === 'bank_stale'), 'last SUCCESSFUL full sync is 21 days old');
});

test('checkSecondAccountStale: only when the setting is on AND a second bank is connected', () => {
  assert.equal(Q.checkSecondAccountStale({ secondAccountBucket: 'internal_second', providers: ['leumi'], transfersIls: 500000 }).length, 0, 'one bank: the setting is still true');
  assert.equal(Q.checkSecondAccountStale({ secondAccountBucket: null, providers: ['leumi', 'hapoalim'] }).length, 0, 'no setting, nothing to fix');
  const out = Q.checkSecondAccountStale({ secondAccountBucket: 'internal_second', providers: ['leumi', 'hapoalim'], transfersIls: 576435 });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].suggested, { setting: 'secondAccountBucket', value: null });
  assert.match(out[0].text, /576,435/);
});
