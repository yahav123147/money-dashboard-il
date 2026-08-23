import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertTx } from '../lib/db.mjs';
import { gatherUnclassified, parseProposals, applyProposal, listRules, removeRule, saveProposals, listProposals, setProposalStatus, alsoMatches, BANK_BUCKETS } from '../lib/classify-agent.mjs';

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
  const dbPath = join(ROOT, 'data', 'test-cla-par.db');
  for (const x of ['', '-wal', '-shm']) rmSync(dbPath + x, { force: true });
  t.after(() => { for (const x of ['', '-wal', '-shm']) rmSync(dbPath + x, { force: true }); });
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
  const p = join(ROOT, 'data', 'test-cla-mig.db');
  for (const x of ['', '-wal', '-shm']) rmSync(p + x, { force: true });
  t.after(() => { for (const x of ['', '-wal', '-shm']) rmSync(p + x, { force: true }); });
  const raw = new Database(p);
  raw.exec(`CREATE TABLE classify_rules (side TEXT NOT NULL, match TEXT NOT NULL, bucket TEXT NOT NULL, bucket_group TEXT NOT NULL, counterparty TEXT, created_at TEXT, PRIMARY KEY (side, match))`);
  raw.prepare(`INSERT INTO classify_rules VALUES ('out','הוט','suppliers_other','expense','x','2026-08-01 10:00:00')`).run();      // first approved
  raw.prepare(`INSERT INTO classify_rules VALUES ('out','הוט מובייל','rent','expense','x','2026-08-02 10:00:00')`).run(); // approved later
  raw.prepare(`UPDATE classify_rules SET created_at='2026-08-03 10:00:00' WHERE match='הוט'`).run();                        // then RE-approved (older rowid)
  raw.close();
  const db = openDb(p);
  const rules = db.prepare('SELECT match, priority FROM classify_rules ORDER BY priority DESC').all();
  assert.equal(rules[0].match, 'הוט', 're-approved rule is first despite the lower rowid');
  assert.deepEqual(rules.map((r) => r.priority), [2, 1]);
  db.close();
});

test('alsoMatches previews the other counterparties a substring rule would claim', (t) => {
  const db = tmpDb(t, 'test-cla10.db');
  tx(db, 'a1', '2026-07-01', -3000, 'הוט מובייל בעמ', 'unclassified', 'unclassified');
  tx(db, 'b1', '2026-07-02', -4000, 'הוט שירותי ענן', 'unclassified', 'unclassified');
  tx(db, 'c1', '2026-07-02', 4000, 'הוט לקוח', 'direct', 'revenue'); // other direction: not listed
  const a = alsoMatches(db, 'out', 'הוט', 'הוט מובייל בעמ');
  assert.deepEqual(a.map((x) => x.name), ['הוט שירותי ענן']);
  assert.deepEqual(alsoMatches(db, 'out', 'הוט מובייל', 'הוט מובייל בעמ'), []);
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
  // undo reopens the proposal in the same transaction
  const u = removeRule(db, { side: 'out', match: 'הוט מובייל בעמ' }, FILE_RULES_MIN);
  assert.equal(u.reopened, 1);
  assert.equal(listProposals(db).find((x) => x.counterparty === 'הוט מובייל בעמ').status, 'pending');
  // a pending proposal whose name is no longer unclassified disappears on the next save
  saveProposals(db, [mk('ספק ב', 'rent')]);
  assert.equal(listProposals(db).some((x) => x.counterparty === 'חדש'), false);
  assert.throws(() => setProposalStatus(db, { side: 'out', counterparty: 'אין', status: 'rejected' }), /לא נמצאה/);
});
