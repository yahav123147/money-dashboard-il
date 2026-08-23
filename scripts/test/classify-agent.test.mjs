import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertTx } from '../lib/db.mjs';
import { gatherUnclassified, parseProposals, applyProposal, BANK_BUCKETS } from '../lib/classify-agent.mjs';

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

test('gatherUnclassified groups by counterparty, biggest first, with samples', (t) => {
  const db = tmpDb(t, 'test-cla1.db');
  tx(db, 'a1', '2026-07-01', -3000, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  tx(db, 'a2', '2026-08-01', -3000, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  tx(db, 'b1', '2026-08-03', -9000, 'משרד עו"ד', 'unclassified', 'unclassified');
  tx(db, 'c1', '2026-08-03', -500, 'קפה', 'suppliers_other', 'expense');
  const u = gatherUnclassified(db);
  assert.equal(u.totalGroups, 2); assert.equal(u.totalRows, 3); assert.equal(u.totalAmount, -15000);
  assert.equal(u.groups[0].counterparty, 'משרד עו"ד');
  assert.equal(u.groups[1].count, 2); assert.equal(u.groups[1].side, 'out');
});

test('parseProposals keeps only vocabulary buckets, known counterparties and a match inside the name', () => {
  const groups = [{ counterparty: 'הוט מובייל בעמ', side: 'out', count: 2, total: -6000 }, { counterparty: 'לקוח א', side: 'in', count: 1, total: 5000 }];
  const text = 'הנה:\n```json\n' + JSON.stringify([
    { counterparty: 'הוט מובייל בעמ', match: 'הוט מובייל', bucket: 'suppliers_other', confidence: 'high', reason: 'טלפון' },
    { counterparty: 'הוט מובייל בעמ', match: 'סלקום', bucket: 'suppliers_other' },
    { counterparty: 'לקוח א', match: 'לקוח א', bucket: 'suppliers_other' },
    { counterparty: 'לקוח א', match: 'לקוח א', bucket: 'direct', confidence: 'weird' },
    { counterparty: 'מי זה', match: 'מי', bucket: 'rent' },
    { counterparty: 'הוט מובייל בעמ', match: 'הוט', bucket: '__proto__' },
    { counterparty: 'הוט מובייל בעמ', match: 'הוט', bucket: 'toString' },
  ]) + '\n```';
  const out = parseProposals(text, groups);
  assert.equal(out.length, 2);
  assert.equal(out[0].group, 'expense'); assert.equal(out[0].label, BANK_BUCKETS.out.suppliers_other.label);
  assert.equal(out[1].bucket, 'direct'); assert.equal(out[1].confidence, 'medium'); assert.equal(out[1].status, 'pending');
  assert.deepEqual(parseProposals('no json here', groups), []);
});

test('gatherUnclassified keeps in and out for the same name apart', (t) => {
  const db = tmpDb(t, 'test-cla3.db');
  tx(db, 'a1', '2026-07-01', -3000, 'דני', 'unclassified', 'unclassified');
  tx(db, 'a2', '2026-08-01', 4000, 'דני', 'unclassified', 'unclassified');
  const u = gatherUnclassified(db);
  assert.equal(u.groups.length, 2);
  assert.deepEqual(u.groups.map((g) => g.side).sort(), ['in', 'out']);
});

test('explicit classify rule beats the refund heuristic on the next full run', async (t) => {
  const { classifyAll } = await import('../lib/classify.mjs');
  const db = tmpDb(t, 'test-cla4.db');
  // money in from "יוסי כהן", then money out to the same name: the heuristic would call it a refund
  tx(db, 'i1', '2026-06-01', 9000, 'יוסי כהן', 'direct', 'revenue');
  tx(db, 'o1', '2026-07-01', -3000, 'יוסי כהן', 'unclassified', 'unclassified');
  const rules = { inflows: [], inflowDefault: { bucket: 'direct', group: 'revenue' }, outflows: [{ match: ['יוסי כהן'], bucket: 'suppliers_other', group: 'expense', source: 'classify' }], outflowDefaults: { largeThreshold: 2000, large: { bucket: 'unclassified', group: 'unclassified' }, small: { bucket: 'suppliers_other', group: 'expense' } }, refundPairs: [], suppliers: [] };
  classifyAll(db, rules);
  assert.equal(db.prepare(`SELECT bucket FROM bank_transactions WHERE id='o1'`).get().bucket, 'suppliers_other');
  delete rules.outflows[0].source;
  classifyAll(db, rules);
  assert.equal(db.prepare(`SELECT bucket FROM bank_transactions WHERE id='o1'`).get().bucket, 'refund_direct', 'without the explicit marker the heuristic still applies');
});

test('applyProposal writes one rule to a rules file and reclassifies the rows', (t) => {
  const db = tmpDb(t, 'test-cla2.db');
  tx(db, 'a1', '2026-07-01', -3000, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  tx(db, 'a2', '2026-08-01', -3200, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  tx(db, 'z1', '2026-08-02', -9000, 'פרילנסר', 'team', 'expense'); // classified some other way: must not move
  const rulesPath = join(ROOT, 'data', 'test-rules.json');
  writeFileSync(rulesPath, JSON.stringify({ inflows: [], inflowDefault: { bucket: 'direct', group: 'revenue' }, outflows: [], outflowDefaults: { largeThreshold: 2000, large: { bucket: 'unclassified', group: 'unclassified' }, small: { bucket: 'suppliers_other', group: 'expense' } } }));
  t.after(() => rmSync(rulesPath, { force: true }));
  tx(db, 'y1', '2026-08-05', -2500, 'הוט מובייל שירותי ענן בעמ', 'unclassified', 'unclassified'); // another counterparty sharing the substring: history must not move
  const res = applyProposal(db, { side: 'out', match: 'הוט מובייל', bucket: 'suppliers_other', counterparty: 'הוט מובייל בעמ' }, rulesPath);
  assert.deepEqual(res.rule, { match: ['הוט מובייל'], bucket: 'suppliers_other', group: 'expense' });
  const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
  assert.equal(rules.outflows.filter((r) => r.source === 'classify').length, 1);
  const rows = db.prepare(`SELECT bucket, bucket_group FROM bank_transactions WHERE counterparty = 'הוט מובייל בעמ'`).all();
  assert.ok(rows.every((r) => r.bucket === 'suppliers_other' && r.bucket_group === 'expense'));
  assert.equal(res.reclassified, 2);
  assert.equal(db.prepare(`SELECT bucket FROM bank_transactions WHERE id='z1'`).get().bucket, 'team');
  assert.equal(db.prepare(`SELECT bucket_group FROM bank_transactions WHERE id='y1'`).get().bucket_group, 'unclassified', 'substring neighbour untouched');
  assert.equal(rules.outflows[0].source, 'classify', 'explicit rule goes first so it beats broad built-ins');
  // a second decision on the same match replaces, not duplicates
  applyProposal(db, { side: 'out', match: 'הוט מובייל', bucket: 'rent', counterparty: 'הוט מובייל בעמ' }, rulesPath);
  const rules2 = JSON.parse(readFileSync(rulesPath, 'utf8'));
  assert.equal(rules2.outflows.filter((r) => r.match?.[0] === 'הוט מובייל').length, 1);
  assert.throws(() => applyProposal(db, { side: 'out', match: 'x', bucket: 'nope', counterparty: 'x' }, rulesPath));
  assert.throws(() => applyProposal(db, { side: 'out', match: 'הוט', bucket: '__proto__', counterparty: 'הוט מובייל בעמ' }, rulesPath), /קטגוריה/);
  assert.throws(() => applyProposal(db, { side: 'out', match: 'הוט', bucket: 'constructor', counterparty: 'הוט מובייל בעמ' }, rulesPath), /קטגוריה/);
});
