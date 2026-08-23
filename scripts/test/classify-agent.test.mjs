import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, upsertTx } from '../lib/db.mjs';
import { gatherUnclassified, parseProposals, applyProposal, listRules, removeRule, saveProposals, listProposals, setProposalStatus, alsoMatches, importLegacyProposals, reconcileProposals, BANK_BUCKETS } from '../lib/classify-agent.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
function tmpDb(t, name) {
  const dir = mkdtempSync(join(tmpdir(), 'money-classify-test-'));
  const p = join(dir, name);
  const db = openDb(p);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}
const tx = (db, id, date, amount, counterparty, bucket, group) => upsertTx(db, {
  id, account_id: 'c', account_number: '1', account_type: 'CHECKING', provider: 't', date, month: date.slice(0, 7),
  amount, currency: 'ILS', counterparty, raw_desc: counterparty, status: 'completed', side: amount > 0 ? 'in' : 'out',
  bucket, bucket_group: group, raw_json: '{}',
});

test('openDb repairs database and WAL sidecar permissions to owner-only', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permission bits are not available on Windows');
  const dir = mkdtempSync(join(tmpdir(), 'money-db-mode-test-'));
  const p = join(dir, 'money.db');
  writeFileSync(p, '');
  chmodSync(p, 0o644);
  const db = openDb(p);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec('CREATE TABLE permission_probe (id INTEGER)');
  for (const file of [p, `${p}-wal`, `${p}-shm`]) {
    assert.equal(statSync(file).mode & 0o777, 0o600, `${file} must be private`);
  }
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

test('raw description is the canonical fallback for blank or whitespace-only counterparties', (t) => {
  const db = tmpDb(t, 'test-cla-blank-name.db');
  const add = (id, rawDesc) => upsertTx(db, {
    id, account_id: 'c', account_number: '1', account_type: 'CHECKING', provider: 't',
    date: '2026-08-01', month: '2026-08', amount: -3000, currency: 'ILS',
    counterparty: '   ', raw_desc: rawDesc, status: 'completed', side: 'out',
    bucket: 'unclassified', bucket_group: 'unclassified', raw_json: '{}',
  });
  add('blank-a', 'Fallback Vendor');
  add('blank-b', 'Fallback Neighbour');
  const gathered = gatherUnclassified(db);
  assert.deepEqual(gathered.groups.map((g) => g.counterparty).sort(), ['Fallback Neighbour', 'Fallback Vendor']);
  assert.deepEqual(alsoMatches(db, 'out', 'Fallback', 'Fallback Vendor').names, [{ name: 'Fallback Neighbour', n: 1 }]);

  saveProposals(db, [{ side: 'out', counterparty: 'Fallback Vendor', match: 'Fallback', bucket: 'rent', group: 'expense', label: 'x', reason: '', confidence: 'high', count: 1, total: -3000 }]);
  applyProposal(db, { side: 'out', match: 'Fallback', bucket: 'rent', counterparty: 'Fallback Vendor' }, FILE_RULES_MIN);
  removeRule(db, { side: 'out', match: 'Fallback' }, FILE_RULES_MIN);
  const current = db.prepare(`SELECT bucket FROM bank_transactions WHERE id='blank-a'`).get().bucket;
  for (const row of [
    { id: 'same-name-card', account_type: 'CARD', currency: 'ILS', date: '2026-09-03', bucket: 'cards', bucket_group: 'expense' },
    { id: 'same-name-fx', account_type: 'CHECKING', currency: 'USD', date: '2026-09-04', bucket: 'fx_account', bucket_group: 'internal' },
  ]) upsertTx(db, {
    ...row, account_id: 'other', account_number: '2', provider: 't', month: row.date.slice(0, 7),
    amount: -10, counterparty: 'Fallback Vendor', raw_desc: 'Fallback Vendor', status: 'completed',
    side: 'out', raw_json: '{}',
  });
  assert.equal(listProposals(db).find((p) => p.counterparty === 'Fallback Vendor').currentBucket, current);
});

test('parseProposals requires side, keeps only vocabulary buckets, known counterparties and a match inside the name', () => {
  const groups = [{ counterparty: 'הוט מובייל בעמ', side: 'out', count: 2, total: -6000 }, { counterparty: 'לקוח א', side: 'in', count: 1, total: 5000 }];
  const text = 'הנה:\n```json\n' + JSON.stringify([
    { counterparty: 'הוט מובייל בעמ', side: 'out', match: 'הוט מובייל', bucket: 'suppliers_other', confidence: 'high', reason: 'טלפון' },
    { counterparty: 'הוט מובייל בעמ', side: 'out', match: 'סלקום', bucket: 'suppliers_other' },
    { counterparty: 'לקוח א', side: 'in', match: 'לקוח א', bucket: 'suppliers_other' },
    { counterparty: 'לקוח א', side: 'in', match: 'לקוח א', bucket: 'direct', confidence: 'weird' },
    { counterparty: 'לקוח א', match: 'לקוח א', bucket: 'direct' },
    { counterparty: 'מי זה', side: 'out', match: 'מי', bucket: 'rent' },
    { counterparty: 'הוט מובייל בעמ', side: 'out', match: 'הוט', bucket: '__proto__' },
    { counterparty: 'הוט מובייל בעמ', side: 'out', match: 'הוט', bucket: 'toString' },
  ]) + '\n```';
  const out = parseProposals(text, groups);
  assert.equal(out.length, 2);
  assert.equal(out[0].group, 'expense'); assert.equal(out[0].label, BANK_BUCKETS.out.suppliers_other.label);
  assert.equal(out[1].bucket, 'direct'); assert.equal(out[1].confidence, 'medium'); assert.equal(out[1].status, 'pending');
  assert.deepEqual(parseProposals(JSON.stringify([
    { counterparty: 'לקוח א', side: 'in', match: 'ל', bucket: 'direct' },
  ]), groups), [], 'a one-character rule can never be approved, so it is not saved');
  assert.equal(parseProposals('no json here', groups), null, 'no JSON = broken answer');
  assert.deepEqual(parseProposals('```json\n[]\n```', groups), [], 'empty array = nothing to propose');
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

test('parseProposals keeps both sides of the same name', () => {
  const groups = [{ counterparty: 'דני', side: 'out', count: 1, total: -3000 }, { counterparty: 'דני', side: 'in', count: 1, total: 4000 }];
  const out = parseProposals(JSON.stringify([
    { counterparty: 'דני', side: 'out', match: 'דני', bucket: 'suppliers_other' },
    { counterparty: 'דני', side: 'in', match: 'דני', bucket: 'direct' },
  ]), groups);
  assert.deepEqual(out.map((p) => p.side + ':' + p.bucket).sort(), ['in:direct', 'out:suppliers_other']);
});

test('applyProposal is one transaction: a failing row update leaves no rule behind', (t) => {
  const db = tmpDb(t, 'test-cla5.db');
  tx(db, 'a1', '2026-07-01', -3000, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  // Force the UPDATE to fail after the rule INSERT by a trigger, then check nothing persisted.
  db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON bank_transactions BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  assert.throws(() => applyProposal(db, { side: 'out', match: 'הוט מובייל', bucket: 'suppliers_other', counterparty: 'הוט מובייל בעמ' }), /disk full/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM classify_rules`).get().n, 0, 'rule rolled back with the rows');
  assert.equal(db.prepare(`SELECT bucket_group FROM bank_transactions WHERE id='a1'`).get().bucket_group, 'unclassified');
});

test('approvals from two processes, concurrently with full reclassify runs, lose nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'money-classify-par-'));
  const dbPath = join(dir, 'money.db');
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const db = openDb(dbPath);
  for (let i = 0; i < 20; i++) { tx(db, `a${i}`, '2026-07-01', -3000, `ספק א ${i % 5}`, 'unclassified', 'unclassified'); tx(db, `b${i}`, '2026-07-02', -4000, `ספק ב ${i % 5}`, 'unclassified', 'unclassified'); }
  db.close();
  const FILE_RULES = JSON.stringify({ inflows: [], inflowDefault: { bucket: 'direct', group: 'revenue' }, outflows: [], outflowDefaults: { largeThreshold: 2000, large: { bucket: 'unclassified', group: 'unclassified' }, small: { bucket: 'suppliers_other', group: 'expense' } }, refundPairs: [], suppliers: [] });
  const approver = (name) => `
    import { openDb } from ${JSON.stringify(join(ROOT, 'scripts', 'lib', 'db.mjs'))};
    import { applyProposal } from ${JSON.stringify(join(ROOT, 'scripts', 'lib', 'classify-agent.mjs'))};
    const db = openDb(${JSON.stringify(dbPath)}); db.pragma('busy_timeout = 30000');
    for (let i = 0; i < 5; i++) applyProposal(db, { side: 'out', match: ${JSON.stringify(name)} + ' ' + i, bucket: 'rent', counterparty: ${JSON.stringify(name)} + ' ' + i });
  `;
  const syncer = `
    import { openDb } from ${JSON.stringify(join(ROOT, 'scripts', 'lib', 'db.mjs'))};
    import { classifyAll } from ${JSON.stringify(join(ROOT, 'scripts', 'lib', 'classify.mjs'))};
    const db = openDb(${JSON.stringify(dbPath)}); db.pragma('busy_timeout = 30000');
    for (let i = 0; i < 5; i++) classifyAll(db, ${FILE_RULES});
  `;
  const { spawn } = await import('node:child_process');
  const run = (code) => new Promise((res) => { const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] }); let err = ''; p.stderr.on('data', (d) => { err += d; }); p.on('exit', (c) => res({ c, err })); });
  const rs = await Promise.all([run(approver('ספק א')), run(approver('ספק ב')), run(syncer)]);
  for (const r of rs) assert.equal(r.c, 0, r.err);
  const db2 = openDb(dbPath);
  assert.equal(db2.prepare(`SELECT COUNT(*) n FROM classify_rules`).get().n, 10, 'every approval kept');
  assert.equal(db2.prepare(`SELECT COUNT(*) n FROM bank_transactions WHERE bucket='rent'`).get().n, 40, 'a concurrent full reclassify never undid an approval');
  db2.close();
});

const FILE_RULES_MIN = { inflows: [], inflowDefault: { bucket: 'direct', group: 'revenue' }, outflows: [], outflowDefaults: { largeThreshold: 2000, large: { bucket: 'unclassified', group: 'unclassified' }, small: { bucket: 'suppliers_other', group: 'expense' } }, refundPairs: [], suppliers: [] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const expectedProposal = (p) => ({ match: p.match, bucket: p.bucket, version: p.version });
const expectedRule = (r) => ({ version: r.version });

test('classifyAll fails closed when the rules table cannot be read', async (t) => {
  const { classifyAll } = await import('../lib/classify.mjs');
  const db = tmpDb(t, 'test-cla7.db');
  tx(db, 'a1', '2026-07-01', -3000, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  applyProposal(db, { side: 'out', match: 'הוט מובייל', bucket: 'rent', counterparty: 'הוט מובייל בעמ' });
  db.exec('DROP TABLE classify_rules');
  assert.throws(() => classifyAll(db, FILE_RULES_MIN), /classify_rules/);
  assert.equal(db.prepare(`SELECT bucket FROM bank_transactions WHERE id='a1'`).get().bucket, 'rent', 'nothing was rewritten');
});


test('applyProposal: rule in SQLite, history of that counterparty moves, neighbours and other rows do not', async (t) => {
  const db = tmpDb(t, 'test-cla2.db');
  tx(db, 'a1', '2026-07-01', -3000, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  tx(db, 'a2', '2026-08-01', -3200, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  tx(db, 'z1', '2026-08-02', -9000, 'פרילנסר', 'unclassified', 'unclassified');
  tx(db, 'y1', '2026-08-05', -2500, 'הוט מובייל שירותי ענן בעמ', 'unclassified', 'unclassified');
  const res = applyProposal(db, { side: 'out', match: 'הוט מובייל בעמ', bucket: 'suppliers_other', counterparty: 'הוט מובייל בעמ' }, FILE_RULES_MIN);
  assert.deepEqual(res.rule, { match: ['הוט מובייל בעמ'], bucket: 'suppliers_other', group: 'expense' });
  assert.equal(res.reclassified, 2);
  assert.ok(db.prepare(`SELECT bucket FROM bank_transactions WHERE counterparty='הוט מובייל בעמ'`).all().every((r) => r.bucket === 'suppliers_other'));
  assert.equal(db.prepare(`SELECT bucket_group FROM bank_transactions WHERE id='z1'`).get().bucket_group, 'unclassified');
  assert.equal(db.prepare(`SELECT bucket_group FROM bank_transactions WHERE id='y1'`).get().bucket_group, 'unclassified', 'match "הוט מובייל בעמ" is not inside the neighbour name');
  assert.throws(() => applyProposal(db, { side: 'out', match: 'xx', bucket: 'nope', counterparty: 'xx' }));
  assert.throws(() => applyProposal(db, { side: 'out', match: 'הוט', bucket: '__proto__', counterparty: 'הוט מובייל בעמ' }), /קטגוריה/);
  assert.throws(() => applyProposal(db, { side: 'out', match: 'הוט', bucket: 'constructor', counterparty: 'הוט מובייל בעמ' }), /קטגוריה/);
  assert.throws(() => applyProposal(db, { side: 'out', match: 'סלקום', bucket: 'rent', counterparty: 'הוט מובייל בעמ' }), /בשם המוטב/);
});

test('re-approval with a new category moves the history in the same call', (t) => {
  const db = tmpDb(t, 'test-cla9.db');
  tx(db, 'a1', '2026-07-01', -3000, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  applyProposal(db, { side: 'out', match: 'הוט מובייל', bucket: 'suppliers_other', counterparty: 'הוט מובייל בעמ' }, FILE_RULES_MIN);
  const res = applyProposal(db, { side: 'out', match: 'הוט מובייל', bucket: 'rent', counterparty: 'הוט מובייל בעמ' }, FILE_RULES_MIN);
  assert.equal(res.reclassified, 1, 'the already-classified row moved');
  assert.equal(db.prepare(`SELECT bucket FROM bank_transactions WHERE id='a1'`).get().bucket, 'rent');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM classify_rules`).get().n, 1);
});

test('newest explicit decision wins over an older broader one, immediately and after a full reclassify', async (t) => {
  const { classifyAll } = await import('../lib/classify.mjs');
  const db = tmpDb(t, 'test-cla6.db');
  tx(db, 'a1', '2026-07-01', -3000, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  applyProposal(db, { side: 'out', match: 'הוט', bucket: 'suppliers_other', counterparty: 'הוט מובייל בעמ' }, FILE_RULES_MIN);
  applyProposal(db, { side: 'out', match: 'הוט מובייל', bucket: 'rent', counterparty: 'הוט מובייל בעמ' }, FILE_RULES_MIN);
  assert.equal(db.prepare(`SELECT bucket FROM bank_transactions WHERE id='a1'`).get().bucket, 'rent', 'immediately');
  classifyAll(db, FILE_RULES_MIN);
  assert.equal(db.prepare(`SELECT bucket FROM bank_transactions WHERE id='a1'`).get().bucket, 'rent', 'after a sync');
  applyProposal(db, { side: 'out', match: 'הוט', bucket: 'suppliers_other', counterparty: 'הוט מובייל בעמ' }, FILE_RULES_MIN);
  assert.equal(db.prepare(`SELECT bucket FROM bank_transactions WHERE id='a1'`).get().bucket, 'suppliers_other', 're-approving the old one promotes it');
  assert.equal(listRules(db)[0].match, 'הוט');
});

test('a broad approval keeps a pending narrower override through a no-work run, and the narrow approval wins', (t) => {
  const db = tmpDb(t, 'test-cla-overlap-pending.db');
  tx(db, 'broad-row', '2026-08-01', -3000, 'הוט אינטרנט', 'unclassified', 'unclassified');
  tx(db, 'narrow-row', '2026-08-01', -4000, 'הוט מובייל', 'unclassified', 'unclassified');
  tx(db, 'still-open-row', '2026-08-01', -5000, 'ספק אחר', 'unclassified', 'unclassified');
  const proposal = (counterparty, match, bucket) => ({ side: 'out', counterparty, match, bucket, group: 'expense', label: bucket, reason: '', confidence: 'high', count: 1, total: -3000 });
  saveProposals(db, [
    proposal('הוט אינטרנט', 'הוט', 'suppliers_other'),
    proposal('הוט מובייל', 'הוט מובייל', 'rent'),
    proposal('ספק אחר', 'ספק אחר', 'team'),
  ]);

  applyProposal(db, proposal('הוט אינטרנט', 'הוט', 'suppliers_other'), FILE_RULES_MIN);
  assert.equal(gatherUnclassified(db, { limit: 0 }).totalRows, 1, 'only the unrelated row remains unclassified');
  const narrowBefore = listProposals(db).find((p) => p.counterparty === 'הוט מובייל');
  assert.equal(narrowBefore.status, 'pending', 'the narrower reviewed option is still open');

  saveProposals(db, []); // the next agent run has no proposal for either group
  const remaining = listProposals(db);
  const narrowAfter = remaining.find((p) => p.counterparty === 'הוט מובייל');
  assert.equal(narrowAfter.version, narrowBefore.version, 'a no-work run preserves the exact pending override');
  assert.equal(remaining.some((p) => p.counterparty === 'ספק אחר'), false, 'an omitted group that is still unclassified is pruned');

  applyProposal(db, proposal('הוט מובייל', 'הוט מובייל', 'rent'), FILE_RULES_MIN,
    { requireProposal: true, expectedProposal: expectedProposal(narrowAfter) });
  assert.equal(db.prepare(`SELECT bucket FROM bank_transactions WHERE id='narrow-row'`).get().bucket, 'rent');
  assert.equal(db.prepare(`SELECT bucket FROM bank_transactions WHERE id='broad-row'`).get().bucket, 'suppliers_other');
  assert.equal(listRules(db)[0].match, 'הוט מובייל', 'the narrower later decision has higher priority');
});

test('removeRule: exactly what the rule claimed falls back, nothing else (both directions)', (t) => {
  const db = tmpDb(t, 'test-cla8.db');
  // (a) a row already in the same bucket by another rule must NOT be reverted
  const rules = { ...FILE_RULES_MIN, outflows: [{ match: ['הוט מובייל ישן'], bucket: 'rent', group: 'expense' }] };
  tx(db, 'old', '2026-06-01', -2900, 'הוט מובייל ישן', 'unclassified', 'unclassified');
  tx(db, 'a1', '2026-07-01', -3000, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  // (b) a broad rule that also caught another counterparty must release it on undo
  tx(db, 'b1', '2026-07-02', -4000, 'הוט שירותי ענן', 'unclassified', 'unclassified');
  applyProposal(db, { side: 'out', match: 'הוט', bucket: 'rent', counterparty: 'הוט מובייל בעמ' }, rules);
  assert.equal(db.prepare(`SELECT bucket FROM bank_transactions WHERE id='b1'`).get().bucket, 'rent', 'broad rule caught the neighbour (by design: it is a substring rule)');
  assert.equal(db.prepare(`SELECT bucket FROM bank_transactions WHERE id='old'`).get().bucket, 'rent');
  const r = removeRule(db, { side: 'out', match: 'הוט' }, rules);
  assert.equal(r.reverted, 2, 'a1 and b1 fell back; old stayed');
  assert.equal(db.prepare(`SELECT bucket_group FROM bank_transactions WHERE id='a1'`).get().bucket_group, 'unclassified');
  assert.equal(db.prepare(`SELECT bucket_group FROM bank_transactions WHERE id='b1'`).get().bucket_group, 'unclassified', 'no rule left to claim it');
  assert.equal(db.prepare(`SELECT bucket FROM bank_transactions WHERE id='old'`).get().bucket, 'rent', 'still classified by its own file rule');
  assert.equal(listRules(db).length, 0);
  assert.throws(() => removeRule(db, { side: 'out', match: 'אין' }, rules), /לא נמצא/);
});

test('priority migration: rules from before the column keep their re-approval order', async (t) => {
  const Database = (await import('better-sqlite3')).default;
  const { openDb } = await import('../lib/db.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'money-classify-priority-'));
  const p = join(dir, 'money.db');
  const raw = new Database(p);
  raw.exec(`CREATE TABLE classify_rules (side TEXT NOT NULL, match TEXT NOT NULL, bucket TEXT NOT NULL, bucket_group TEXT NOT NULL, counterparty TEXT, created_at TEXT, PRIMARY KEY (side, match))`);
  raw.prepare(`INSERT INTO classify_rules VALUES ('out','הוט','suppliers_other','expense','x','2026-08-01 10:00:00')`).run();      // first approved
  raw.prepare(`INSERT INTO classify_rules VALUES ('out','הוט מובייל','rent','expense','x','2026-08-02 10:00:00')`).run(); // approved later
  raw.prepare(`UPDATE classify_rules SET created_at='2026-08-03 10:00:00' WHERE match='הוט'`).run();                        // then RE-approved (older rowid)
  raw.close();
  const db = openDb(p);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const rules = db.prepare('SELECT match, priority, rule_version AS version FROM classify_rules ORDER BY priority DESC').all();
  assert.equal(rules[0].match, 'הוט', 're-approved rule is first despite the lower rowid');
  assert.deepEqual(rules.map((r) => r.priority), [2, 1]);
  assert.ok(rules.every((r) => UUID_RE.test(r.version)), 'every migrated rule receives an immutable UUID');
});

test('alsoMatches previews the other counterparties a substring rule would claim', (t) => {
  const db = tmpDb(t, 'test-cla10.db');
  tx(db, 'a1', '2026-07-01', -3000, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  tx(db, 'b1', '2026-07-02', -4000, 'הוט שירותי ענן', 'unclassified', 'unclassified');
  tx(db, 'c1', '2026-07-02', 4000, 'הוט לקוח', 'direct', 'revenue'); // other direction: not listed
  for (let i = 0; i < 8; i++) tx(db, `m${i}`, '2026-07-03', -100, `הוט סניף ${i}`, 'unclassified', 'unclassified');
  const a = alsoMatches(db, 'out', 'הוט', 'הוט מובייל בעמ');
  assert.equal(a.total, 9, 'every affected counterparty is counted');
  assert.equal(a.rows, 9);
  assert.equal(a.names.length, 6, 'names are capped, the count is not');
  assert.equal(alsoMatches(db, 'out', 'הוט מובייל', 'הוט מובייל בעמ').total, 0);
});

test('proposals live in SQLite: save keeps decisions, approve/undo/reject move status in the same transaction', (t) => {
  const db = tmpDb(t, 'test-cla11.db');
  tx(db, 'a1', '2026-07-01', -3000, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  tx(db, 'b1', '2026-07-02', -4000, 'ספק ב', 'unclassified', 'unclassified');
  const mk = (counterparty, bucket) => ({ side: 'out', counterparty, match: counterparty, bucket, group: 'expense', label: 'x', reason: '', confidence: 'high', count: 1, total: -3000 });
  assert.equal(saveProposals(db, [mk('הוט מובייל בעמ', 'suppliers_other'), mk('ספק ב', 'rent')]), 2);
  assert.equal(listProposals(db).length, 2);
  const res = applyProposal(db, { side: 'out', match: 'הוט מובייל בעמ', bucket: 'suppliers_other', counterparty: 'הוט מובייל בעמ' }, FILE_RULES_MIN);
  let p = listProposals(db).find((x) => x.counterparty === 'הוט מובייל בעמ');
  assert.equal(p.status, 'approved'); assert.equal(p.reclassified, res.reclassified);
  setProposalStatus(db, { side: 'out', counterparty: 'ספק ב', status: 'rejected' });
  // a new agent run proposes a different bucket for the approved one: the decision stays
  saveProposals(db, [mk('הוט מובייל בעמ', 'rent'), mk('ספק ב', 'rent'), mk('חדש', 'team')]);
  p = listProposals(db).find((x) => x.counterparty === 'הוט מובייל בעמ');
  assert.equal(p.status, 'approved'); assert.equal(p.bucket, 'suppliers_other', 'decided proposals keep their bucket');
  assert.equal(listProposals(db).find((x) => x.counterparty === 'ספק ב').status, 'rejected');
  assert.equal(listProposals(db).find((x) => x.counterparty === 'חדש').status, 'pending');
  // undo marks the proposal "undone" in the same transaction; it survives later saves even if a built-in now claims the rows
  const u = removeRule(db, { side: 'out', match: 'הוט מובייל בעמ' }, FILE_RULES_MIN);
  assert.equal(u.reopened, 1);
  let und = listProposals(db).find((x) => x.counterparty === 'הוט מובייל בעמ');
  assert.equal(und.status, 'undone'); assert.equal(und.currentBucket, 'unclassified');
  saveProposals(db, [mk('ספק ב', 'rent')]);
  und = listProposals(db).find((x) => x.counterparty === 'הוט מובייל בעמ');
  assert.equal(und.status, 'undone', 'kept');
  const oldVersion = und.version;
  // If the agent sees it again, undone is an open proposal: replace every
  // proposal field together and publish the fresh suggestion as pending.
  saveProposals(db, [mk('ספק ב', 'rent'), { ...mk('הוט מובייל בעמ', 'team'), match: 'הוט מובייל', label: 'צוות חדש', reason: 'הצעה חדשה' }]);
  und = listProposals(db).find((x) => x.counterparty === 'הוט מובייל בעמ');
  assert.deepEqual({ status: und.status, match: und.match, bucket: und.bucket, label: und.label, reason: und.reason },
    { status: 'pending', match: 'הוט מובייל', bucket: 'team', label: 'צוות חדש', reason: 'הצעה חדשה' });
  assert.notEqual(und.version, oldVersion);
  // and the owner can approve that fresh match with another chosen category
  applyProposal(db, { side: 'out', match: 'הוט מובייל', bucket: 'rent', counterparty: 'הוט מובייל בעמ' }, FILE_RULES_MIN);
  assert.equal(listProposals(db).find((x) => x.counterparty === 'הוט מובייל בעמ').status, 'approved');
  // a pending proposal whose name is no longer unclassified disappears on the next save
  assert.equal(listProposals(db).some((x) => x.counterparty === 'חדש'), false);
  assert.throws(() => setProposalStatus(db, { side: 'out', counterparty: 'אין', status: 'rejected' }), /לא נמצאה/);
});

test('status transitions are atomic: approve then reject (or approve twice) cannot disagree with the rule', (t) => {
  const db = tmpDb(t, 'test-cla12.db');
  tx(db, 'a1', '2026-07-01', -3000, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  saveProposals(db, [{ side: 'out', counterparty: 'הוט מובייל בעמ', match: 'הוט מובייל', bucket: 'rent', group: 'expense', label: 'x', reason: '', confidence: 'high', count: 1, total: -3000 }]);
  applyProposal(db, { side: 'out', match: 'הוט מובייל', bucket: 'rent', counterparty: 'הוט מובייל בעמ' }, FILE_RULES_MIN);
  assert.throws(() => setProposalStatus(db, { side: 'out', counterparty: 'הוט מובייל בעמ', status: 'rejected' }), /חוק פעיל/, 'no reject over an active rule');
  assert.throws(() => applyProposal(db, { side: 'out', match: 'הוט מובייל', bucket: 'team', counterparty: 'הוט מובייל בעמ' }, FILE_RULES_MIN), /כבר הוחלטה/, 'no second approve without undo');
  assert.equal(listProposals(db)[0].bucket, 'rent');
});

test('one rule is one decision: approval aligns every proposal and later rejection is blocked', (t) => {
  const db = tmpDb(t, 'test-cla13.db');
  tx(db, 'a1', '2026-07-01', -3000, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  tx(db, 'b1', '2026-07-01', -3000, 'הוט אינטרנט', 'unclassified', 'unclassified');
  const mk = (c, b) => ({ side: 'out', counterparty: c, match: 'הוט', bucket: b, group: 'expense', label: 'x', reason: '', confidence: 'high', count: 1, total: -3000 });
  saveProposals(db, [mk('הוט מובייל בעמ', 'suppliers_other'), mk('הוט אינטרנט', 'rent')]);
  setProposalStatus(db, { side: 'out', counterparty: 'הוט אינטרנט', status: 'rejected' });
  applyProposal(db, { side: 'out', match: 'הוט', bucket: 'suppliers_other', counterparty: 'הוט מובייל בעמ' }, FILE_RULES_MIN);
  let ps = listProposals(db);
  assert.ok(ps.every((p) => p.status === 'approved' && p.bucket === 'suppliers_other'), 'later rule approval supersedes the older rejection for the same canonical rule');
  assert.equal(listRules(db).length, 1);
  assert.ok(db.prepare(`SELECT bucket FROM bank_transactions`).all().every((r) => r.bucket === 'suppliers_other'));
  assert.throws(() => setProposalStatus(db, { side: 'out', counterparty: 'הוט אינטרנט', status: 'rejected' }), /חוק פעיל/, 'cannot reject one proposal while its canonical rule is active');
  const undone = removeRule(db, { side: 'out', match: 'הוט' }, FILE_RULES_MIN);
  assert.equal(undone.reopened, 2, 'undo reopens every proposal represented by the rule');
  applyProposal(db, { side: 'out', match: 'הוט', bucket: 'rent', counterparty: 'הוט אינטרנט' }, FILE_RULES_MIN);
  ps = listProposals(db);
  assert.ok(ps.every((p) => p.status === 'approved' && p.bucket === 'rent'), 're-approval aligns all undone proposals too');
});

test('API approval cannot change an active canonical rule or create an orphan after its proposal disappeared', (t) => {
  const db = tmpDb(t, 'test-cla-api-race.db');
  tx(db, 'a1', '2026-07-01', -3000, 'הוט מובייל', 'unclassified', 'unclassified');
  tx(db, 'b1', '2026-07-01', -2000, 'הוט אינטרנט', 'unclassified', 'unclassified');
  const mk = (counterparty, bucket) => ({ side: 'out', counterparty, match: 'הוט', bucket, group: 'expense', label: 'x', reason: '', confidence: 'high', count: 1, total: -1 });
  saveProposals(db, [mk('הוט מובייל', 'suppliers_other'), mk('הוט אינטרנט', 'team')]);
  applyProposal(db, { side: 'out', match: 'הוט', bucket: 'suppliers_other', counterparty: 'הוט מובייל' }, FILE_RULES_MIN);

  // Simulate a proposal table left by the first SQLite release: the active
  // rule exists, but another proposal with that canonical match is pending.
  db.prepare(`UPDATE classify_proposals SET status='pending', bucket='team' WHERE side='out' AND counterparty='הוט אינטרנט'`).run();
  const staleActive = listProposals(db).find((p) => p.counterparty === 'הוט אינטרנט');
  assert.throws(() => applyProposal(db,
    { side: 'out', match: 'הוט', bucket: 'team', counterparty: 'הוט אינטרנט' },
    FILE_RULES_MIN, { requireProposal: true, expectedProposal: expectedProposal(staleActive) }), /חוק כבר פעיל/);
  assert.equal(listRules(db)[0].bucket, 'suppliers_other');

  tx(db, 'c1', '2026-07-01', -1000, 'ספק שנמחק', 'unclassified', 'unclassified');
  const gone = { side: 'out', counterparty: 'ספק שנמחק', match: 'ספק שנמחק', bucket: 'rent', group: 'expense', label: 'x', reason: '', confidence: 'high', count: 1, total: -1 };
  saveProposals(db, [gone]);
  const goneExpected = expectedProposal(listProposals(db).find((p) => p.counterparty === gone.counterparty));
  saveProposals(db, []); // agent run deleted it after the route had read it
  assert.throws(() => applyProposal(db, gone, FILE_RULES_MIN, { requireProposal: true, expectedProposal: goneExpected }), /לא נמצאה/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM classify_rules WHERE match='ספק שנמחק'`).get().n, 0);
  assert.equal(db.prepare(`SELECT bucket FROM bank_transactions WHERE id='c1'`).get().bucket, 'unclassified');
});

test('API decisions are bound to the exact proposal version the owner saw', (t) => {
  const db = tmpDb(t, 'test-cla-proposal-version.db');
  tx(db, 'version-row', '2026-08-01', -3000, 'Alpha Beta', 'unclassified', 'unclassified');
  const mk = (match, bucket) => ({ side: 'out', counterparty: 'Alpha Beta', match, bucket, group: 'expense', label: bucket, reason: match, confidence: 'high', count: 1, total: -3000 });
  saveProposals(db, [mk('Alpha', 'rent')]);
  const stale = listProposals(db)[0];
  saveProposals(db, [mk('Beta', 'team')]);
  const current = listProposals(db)[0];
  assert.notEqual(current.version, stale.version);
  assert.deepEqual([current.match, current.bucket, current.status], ['Beta', 'team', 'pending']);

  assert.throws(() => applyProposal(db,
    { side: stale.side, counterparty: stale.counterparty, match: stale.match, bucket: stale.bucket },
    FILE_RULES_MIN, { requireProposal: true, expectedProposal: expectedProposal(stale) }), /השתנתה/);
  assert.throws(() => setProposalStatus(db,
    { side: stale.side, counterparty: stale.counterparty, status: 'rejected' },
    { expectedProposal: expectedProposal(stale) }), /השתנתה/);
  assert.equal(listRules(db).length, 0);
  assert.deepEqual([listProposals(db)[0].match, listProposals(db)[0].bucket, listProposals(db)[0].status], ['Beta', 'team', 'pending']);
  assert.equal(db.prepare(`SELECT bucket FROM bank_transactions WHERE id='version-row'`).get().bucket, 'unclassified');

  // Deleting and later recreating an identical proposal must not reset its
  // identity (the ABA case): the old page is still stale.
  saveProposals(db, []);
  saveProposals(db, [mk('Beta', 'team')]);
  const recreated = listProposals(db)[0];
  assert.notEqual(recreated.version, current.version);
  assert.throws(() => applyProposal(db,
    { side: current.side, counterparty: current.counterparty, match: current.match, bucket: current.bucket },
    FILE_RULES_MIN, { requireProposal: true, expectedProposal: expectedProposal(current) }), /השתנתה/);

  // The expected bucket identifies the displayed proposal. The desired bucket
  // is separate, so an explicit category override can still be approved.
  applyProposal(db, { side: recreated.side, counterparty: recreated.counterparty, match: recreated.match, bucket: 'rent' },
    FILE_RULES_MIN, { requireProposal: true, expectedProposal: expectedProposal(recreated) });
  assert.deepEqual([listRules(db)[0].match, listRules(db)[0].bucket], ['Beta', 'rent']);
});

test('proposal versions rotate across every state transition and close approve/undo ABA', (t) => {
  const db = tmpDb(t, 'proposal-state-aba.db');
  tx(db, 'aba-row', '2026-08-01', -3000, 'Alpha Beta', 'unclassified', 'unclassified');
  const proposal = { side: 'out', counterparty: 'Alpha Beta', match: 'Alpha', bucket: 'rent', group: 'expense', label: 'rent', reason: '', confidence: 'high', count: 1, total: -3000 };
  saveProposals(db, [proposal]);
  const pending = listProposals(db)[0];

  applyProposal(db, proposal, FILE_RULES_MIN, { requireProposal: true, expectedProposal: expectedProposal(pending) });
  const approved = listProposals(db)[0];
  assert.notEqual(approved.version, pending.version, 'approve rotates the proposal identity');

  const activeRule = listRules(db)[0];
  removeRule(db, { side: activeRule.side, match: activeRule.match }, FILE_RULES_MIN, { expectedRule: expectedRule(activeRule) });
  const undone = listProposals(db)[0];
  assert.notEqual(undone.version, approved.version, 'undo rotates the proposal identity');
  assert.throws(() => applyProposal(db, proposal, FILE_RULES_MIN,
    { requireProposal: true, expectedProposal: expectedProposal(pending) }), /\u05d4\u05e9\u05ea\u05e0\u05ea\u05d4/, 'the pre-approval page cannot restore an undone rule');

  setProposalStatus(db, { side: undone.side, counterparty: undone.counterparty, status: 'rejected' },
    { expectedProposal: expectedProposal(undone) });
  const rejected = listProposals(db)[0];
  assert.notEqual(rejected.version, undone.version, 'reject rotates the proposal identity');

  db.prepare(`INSERT INTO classify_rules
    (side,match,bucket,bucket_group,counterparty,created_at,priority,rule_version)
    VALUES ('out','Alpha','rent','expense','Alpha Beta',datetime('now'),1,'manual-rule')`).run();
  assert.equal(reconcileProposals(db).aligned, 1);
  const realigned = listProposals(db)[0];
  assert.equal(realigned.status, 'approved');
  assert.notEqual(realigned.version, rejected.version, 'rule reconciliation rotates the proposal identity');
  db.prepare(`DELETE FROM classify_rules WHERE side='out' AND match='Alpha'`).run();
  assert.equal(reconcileProposals(db).undone, 1);
  assert.notEqual(listProposals(db)[0].version, realigned.version, 'missing-rule reconciliation rotates the proposal identity');
});

test('a stale rule view cannot undo a recreated rule with the same side and match', (t) => {
  const db = tmpDb(t, 'rule-aba.db');
  tx(db, 'rule-aba-row', '2026-08-01', -3000, 'Alpha Beta', 'unclassified', 'unclassified');
  const proposal = { side: 'out', counterparty: 'Alpha Beta', match: 'Alpha', bucket: 'rent', group: 'expense', label: 'rent', reason: '', confidence: 'high', count: 1, total: -3000 };
  saveProposals(db, [proposal]);
  applyProposal(db, proposal, FILE_RULES_MIN, { requireProposal: true, expectedProposal: expectedProposal(listProposals(db)[0]) });
  const oldRule = listRules(db)[0];
  removeRule(db, { side: oldRule.side, match: oldRule.match }, FILE_RULES_MIN, { expectedRule: expectedRule(oldRule) });
  const reopened = listProposals(db)[0];
  applyProposal(db, proposal, FILE_RULES_MIN, { requireProposal: true, expectedProposal: expectedProposal(reopened) });
  const recreated = listRules(db)[0];
  assert.notEqual(recreated.version, oldRule.version);
  assert.equal(recreated.priority, oldRule.priority, 'priority can be reused, so it is not an ABA-safe identity');
  assert.throws(() => removeRule(db, { side: oldRule.side, match: oldRule.match }, FILE_RULES_MIN,
    { expectedRule: expectedRule(oldRule) }), (err) => err?.code === 'RULE_CONFLICT');
  assert.equal(listRules(db)[0].version, recreated.version, 'the recreated rule survived the stale undo');
});

test('proposal version is migrated safely on an existing SQLite proposal table', async (t) => {
  const Database = (await import('better-sqlite3')).default;
  const dir = mkdtempSync(join(tmpdir(), 'money-classify-proposal-migration-'));
  const p = join(dir, 'money.db');
  const raw = new Database(p);
  raw.exec(`CREATE TABLE classify_proposals (
    side TEXT NOT NULL, counterparty TEXT NOT NULL, match TEXT, bucket TEXT, bucket_group TEXT, label TEXT,
    reason TEXT, confidence TEXT, count INTEGER, total REAL, status TEXT NOT NULL DEFAULT 'pending',
    proposed_at TEXT, decided_at TEXT, reclassified INTEGER, PRIMARY KEY (side, counterparty));
    INSERT INTO classify_proposals (side,counterparty,match,bucket,status) VALUES ('out','legacy','legacy','rent','pending');`);
  raw.close();
  const db = openDb(p);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.ok(db.prepare(`PRAGMA table_info(classify_proposals)`).all().some((c) => c.name === 'proposal_version'));
  assert.equal(listProposals(db)[0].version, 'legacy-1');
});

test('cold schema migration is serialized across concurrent openDb processes', async (t) => {
  const Database = (await import('better-sqlite3')).default;
  const dir = mkdtempSync(join(tmpdir(), 'money-classify-cold-migration-'));
  const p = join(dir, 'money.db');
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const raw = new Database(p);
  raw.exec(`
    CREATE TABLE bank_transactions (
      id TEXT PRIMARY KEY, account_id TEXT, account_number TEXT, account_type TEXT,
      provider TEXT, date TEXT, month TEXT, amount REAL, currency TEXT,
      counterparty TEXT, raw_desc TEXT, status TEXT, side TEXT, bucket TEXT,
      bucket_group TEXT, raw_json TEXT, updated_at TEXT);
    CREATE INDEX idx_tx_month ON bank_transactions(month);
    CREATE TABLE cardcom_sales (
      deal_id TEXT PRIMARY KEY, dt TEXT, date TEXT, amount REAL, product TEXT,
      product_raw TEXT, product_source TEXT, raw_json TEXT, updated_at TEXT);
    CREATE TABLE classify_rules (
      side TEXT NOT NULL, match TEXT NOT NULL, bucket TEXT NOT NULL, bucket_group TEXT NOT NULL,
      counterparty TEXT, created_at TEXT, PRIMARY KEY (side, match));
    INSERT INTO classify_rules VALUES ('out','legacy','rent','expense','legacy','2026-08-01 10:00:00');
    CREATE TABLE classify_proposals (
      side TEXT NOT NULL, counterparty TEXT NOT NULL, match TEXT, bucket TEXT, bucket_group TEXT, label TEXT,
      reason TEXT, confidence TEXT, count INTEGER, total REAL, status TEXT NOT NULL DEFAULT 'pending',
      proposed_at TEXT, decided_at TEXT, reclassified INTEGER, PRIMARY KEY (side, counterparty));
    INSERT INTO classify_proposals (side,counterparty,match,bucket,status) VALUES ('out','legacy','legacy','rent','pending');
  `);
  raw.close();

  const { spawn } = await import('node:child_process');
  const modulePath = join(ROOT, 'scripts', 'lib', 'db.mjs');
  const code = `import { openDb } from ${JSON.stringify(modulePath)}; const db=openDb(${JSON.stringify(p)}); db.close();`;
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (d) => { error += d; });
    child.on('exit', (exitCode) => resolve({ exitCode, error }));
  });
  for (let round = 0; round < 3; round++) {
    const results = await Promise.all(Array.from({ length: 20 }, run));
    for (const result of results) assert.equal(result.exitCode, 0, `round ${round + 1}: ${result.error}`);
  }

  const migrated = openDb(p);
  const ruleCols = migrated.prepare('PRAGMA table_info(classify_rules)').all().map((c) => c.name);
  const proposalCols = migrated.prepare('PRAGMA table_info(classify_proposals)').all().map((c) => c.name);
  const txCols = migrated.prepare('PRAGMA table_info(bank_transactions)').all().map((c) => c.name);
  const cardcomCols = migrated.prepare('PRAGMA table_info(cardcom_sales)').all().map((c) => c.name);
  assert.ok(ruleCols.includes('priority'));
  assert.ok(ruleCols.includes('rule_version'));
  assert.ok(proposalCols.includes('proposal_version'));
  assert.ok(txCols.includes('sub_bucket'));
  assert.ok(txCols.includes('expense_channel'));
  assert.ok(cardcomCols.includes('channel') || cardcomCols.includes('acquirer'), 'repo-specific CardCom migration completed');
  assert.equal(migrated.prepare(`SELECT priority FROM classify_rules WHERE match='legacy'`).get().priority, 1);
  assert.match(migrated.prepare(`SELECT rule_version FROM classify_rules WHERE match='legacy'`).get().rule_version, UUID_RE);
  migrated.close();
});

test('saveProposals records the run in the same transaction; legacy proposals.json decisions are imported once', (t) => {
  const db = tmpDb(t, 'test-cla14.db');
  saveProposals(db, [], { note: 'x' });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM agent_runs WHERE agent='classify' AND ok=1`).get().n, 1);
  const proposal = (counterparty, status = 'pending') => ({ side: 'out', counterparty, match: counterparty, bucket: 'rent', group: 'expense', label: 'x', reason: '', confidence: 'high', count: 1, total: -1, status });
  saveProposals(db, [proposal('ישן'), { ...proposal('פעיל'), match: 'משותף', bucket: 'team' }]);
  db.prepare(`INSERT INTO classify_proposals (side,counterparty,match,bucket,bucket_group,status,decided_at) VALUES ('out','חדש','חדש','team','expense','approved','2026-08-20')`).run();
  db.prepare(`INSERT INTO classify_rules (side,match,bucket,bucket_group,counterparty,created_at,priority) VALUES ('out','חדש','team','expense','חדש','2026-08-20',1), ('out','משותף','rent','expense','פעיל','2026-08-21',2)`).run();
  const legacyDir = mkdtempSync(join(tmpdir(), 'money-classify-legacy-'));
  const f = join(legacyDir, 'proposals.json');
  writeFileSync(f, JSON.stringify({ ts: '2026-08-01T00:00:00Z', proposals: [
    { ...proposal('ישן', 'rejected'), appliedAt: '2026-08-01T00:00:00Z' },
    { ...proposal('חדש', 'rejected'), appliedAt: '2026-08-01T00:00:00Z' },
    { ...proposal('נוסף', 'approved'), appliedAt: '2026-08-01T00:00:00Z' },
    { ...proposal('פעיל', 'rejected'), match: 'משותף', bucket: 'team', appliedAt: '2026-08-01T00:00:00Z' },
    { side: 'out', counterparty: 'פתוח', match: 'פתוח', bucket: 'rent', group: 'expense', status: 'pending', count: 1, total: -1 },
  ] }));
  t.after(() => { rmSync(legacyDir, { recursive: true, force: true }); });
  assert.equal(importLegacyProposals(db, f), 3, 'legacy decisions override pending rows and insert missing decisions');
  const byName = new Map(listProposals(db).map((p) => [p.counterparty, p]));
  assert.equal(byName.get('ישן').status, 'rejected', 'legacy decision beats interim pending SQLite row');
  assert.equal(byName.get('חדש').status, 'approved', 'newer decided SQLite row is never overwritten');
  assert.equal(byName.get('חדש').bucket, 'team');
  assert.equal(byName.get('פעיל').status, 'approved', 'an active canonical rule wins over a legacy rejection');
  assert.equal(byName.get('פעיל').bucket, 'rent');
  assert.equal(byName.get('נוסף').status, 'undone', 'approved history without an active rule is reopened instead of getting stuck');
  db.prepare(`UPDATE classify_proposals SET status='approved' WHERE side='out' AND counterparty='נוסף'`).run();
  assert.deepEqual(reconcileProposals(db), { undone: 1, aligned: 0 }, 'already-imported databases are repaired without the legacy file');
  assert.deepEqual(reconcileProposals(db), { undone: 0, aligned: 0 }, 'the upgrade repair is idempotent');
  assert.equal(importLegacyProposals(db, f), 0, 'file was renamed; second call is a no-op');
});
