// Regressions found in a fresh third-party install, August 2026. Each test
// here failed before its fix; none of them would have been caught by the
// existing suite, because every one of them fails silently in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertTx, cleanupPendingRows } from '../lib/db.mjs';
import { classifyRow, classifyAll, loadRules } from '../lib/classify.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

function tmpDb(t, name) {
  const p = join(ROOT, 'data', name);
  for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true });
  const db = openDb(p);
  t.after(() => { db.close(); for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true }); });
  return db;
}

// ---------------------------------------------------------------------------
// The config file must define every key the code reads off it.
//
// `settings.flagThresholdIls` was read in lib/queries.js and defined nowhere.
// An undefined bind is NULL in SQLite, `ABS(amount) >= NULL` is never true,
// and so the "large movement" alert was switched off for every install without
// one line of error output. Anything of this shape is invisible, so the guard
// is structural rather than a single test for a single key.
// ---------------------------------------------------------------------------
test('every settings key the code reads is defined in config/settings.json', () => {
  const settings = readJson('config/settings.json');
  const sources = ['lib/queries.js', 'scripts/financy-sync.mjs', 'scripts/demo-seed.mjs'];
  const missing = [];
  for (const src of sources) {
    const text = readFileSync(join(ROOT, src), 'utf8');
    // The lookbehind keeps the filename in join(ROOT, 'config', 'settings.json')
    // from reading as a property access.
    for (const m of text.matchAll(/(?<!['"`\w.])settings\.([A-Za-z_$][\w$]*)/g)) {
      if (!(m[1] in settings)) missing.push(`${src}: settings.${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `read but never defined:\n${missing.join('\n')}`);
});

test('the large-movement alert actually fires', async (t) => {
  const { computeFlags, settings } = await import('../../lib/queries.js');
  const db = tmpDb(t, 'test-reg-flags.db');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  const over = Number(settings.flagThresholdIls) * 2;
  upsertTx(db, {
    id: 'big-1', account_id: 'a', account_number: '1', account_type: 'CHECKING',
    provider: 'p', date: today, month: today.slice(0, 7), amount: -over,
    currency: 'ILS', counterparty: 'ספק גדול', raw_desc: '', status: 'completed',
    side: 'out', bucket: 'suppliers_other', bucket_group: 'expense', raw_json: '{}',
  });
  const flags = computeFlags(db);
  assert.ok(flags.some((f) => f.type === 'large_amount'),
    'a transaction at twice the threshold must raise large_amount');
});

// ---------------------------------------------------------------------------
// No literal year anywhere in the year-to-date windows.
// ---------------------------------------------------------------------------
test('tax-year windows are derived, never written as a literal', async () => {
  const { taxYearStart } = await import('../../lib/queries.js');
  assert.equal(taxYearStart('2026-08'), '2026-01');
  assert.equal(taxYearStart('2027-01'), '2027-01');
  assert.equal(taxYearStart('2031-12'), '2031-01');

  const text = readFileSync(join(ROOT, 'lib/queries.js'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'));
  const literals = text.filter((l) => /'\d{4}-\d{2}'/.test(l));
  assert.deepEqual(literals, [], `hardcoded year-month literal:\n${literals.join('\n')}`);
});

test('the demo follows the clock instead of a pinned year', async () => {
  const { demoMonths } = await import('../demo-seed.mjs');
  assert.equal(demoMonths('2026-08-18').length, 8);
  assert.equal(demoMonths('2026-08-18').at(-1), '2026-08');
  assert.equal(demoMonths('2027-01-05').at(-1), '2027-01');
  assert.equal(demoMonths('2027-03-10').at(0), '2026-08');
});

// ---------------------------------------------------------------------------
// Refund pairing. A token subset in either direction, over the whole period,
// with no sense of scale, turned a ILS 3.20 credit from a phone company into a
// licence to reclassify every phone bill that year as a customer refund.
// ---------------------------------------------------------------------------
test('a tiny credit cannot turn a supplier into a refund', (t) => {
  const db = tmpDb(t, 'test-reg-refund.db');
  const rules = { ...loadRules(), refundPairs: [], suppliers: [] };
  const add = (id, date, amount, counterparty) => upsertTx(db, {
    id, account_id: 'a', account_number: '1', account_type: 'CHECKING',
    provider: 'p', date, month: date.slice(0, 7), amount, currency: 'ILS',
    counterparty, raw_desc: '', status: 'completed',
    side: amount >= 0 ? 'in' : 'out', bucket: null, bucket_group: null, raw_json: '{}',
  });
  add('in-1', '2026-01-01', 3.2, 'סלולר גלים');
  add('out-1', '2026-02-10', -194.83, 'סלולר גלים בע"מ');
  add('in-2', '2026-03-01', 5000, 'לקוח משלם טוב');
  add('out-2', '2026-04-01', -1200, 'לקוח משלם טוב');
  classifyAll(db, rules);

  const bucketOf = (id) => db.prepare('SELECT bucket FROM bank_transactions WHERE id=?').get(id).bucket;
  assert.notEqual(bucketOf('out-1'), 'refund_direct',
    'ILS 3.20 in cannot justify ILS 194.83 back out');
  assert.equal(bucketOf('out-2'), 'refund_direct',
    'a client who paid ILS 5,000 getting ILS 1,200 back is a real refund');
});

test('a refund cannot precede the payment it refunds', (t) => {
  const db = tmpDb(t, 'test-reg-refund-time.db');
  const rules = { ...loadRules(), refundPairs: [], suppliers: [] };
  const add = (id, date, amount, counterparty) => upsertTx(db, {
    id, account_id: 'a', account_number: '1', account_type: 'CHECKING',
    provider: 'p', date, month: date.slice(0, 7), amount, currency: 'ILS',
    counterparty, raw_desc: '', status: 'completed',
    side: amount >= 0 ? 'in' : 'out', bucket: null, bucket_group: null, raw_json: '{}',
  });
  // Money out in January, the matching money in only arrives in August. The
  // amount test alone waves this through; only the date test catches it.
  add('out-early', '2026-01-07', -500, 'מסעדת הגן הירוק');
  add('in-late', '2026-08-20', 500, 'מסעדת הגן הירוק בע"מ');
  // The same pair in the right order is a genuine refund.
  add('in-first', '2026-02-01', 900, 'מרפאת שיניים אלון');
  add('out-after', '2026-03-01', -400, 'מרפאת שיניים אלון');
  classifyAll(db, rules);
  const bucketOf = (id) => db.prepare('SELECT bucket FROM bank_transactions WHERE id=?').get(id).bucket;
  assert.notEqual(bucketOf('out-early'), 'refund_direct',
    'money cannot be refunded seven months before it arrives');
  assert.equal(bucketOf('out-after'), 'refund_direct',
    'paid in February, refunded in March, is a real refund');
});

test('one payment in cannot fund an unlimited number of refunds', (t) => {
  const db = tmpDb(t, 'test-reg-refund-pool.db');
  const rules = { ...loadRules(), refundPairs: [], suppliers: [] };
  const add = (id, date, amount, counterparty) => upsertTx(db, {
    id, account_id: 'a', account_number: '1', account_type: 'CHECKING',
    provider: 'p', date, month: date.slice(0, 7), amount, currency: 'ILS',
    counterparty, raw_desc: '', status: 'completed',
    side: amount >= 0 ? 'in' : 'out', bucket: null, bucket_group: null, raw_json: '{}',
  });
  // ILS 1,000 received, then three ILS 600 payments out to the same name.
  // The pool funds the first and no more: 1,000 covers 600, the remaining 400
  // does not cover the second.
  add('in-1', '2026-01-01', 1000, 'סטודיו אורן');
  add('out-1', '2026-02-01', -600, 'סטודיו אורן');
  add('out-2', '2026-03-01', -600, 'סטודיו אורן');
  add('out-3', '2026-04-01', -600, 'סטודיו אורן');
  classifyAll(db, rules);
  const bucketOf = (id) => db.prepare('SELECT bucket FROM bank_transactions WHERE id=?').get(id).bucket;
  assert.equal(bucketOf('out-1'), 'refund_direct', 'the first refund is covered');
  assert.notEqual(bucketOf('out-2'), 'refund_direct', 'ILS 400 left cannot cover ILS 600');
  assert.notEqual(bucketOf('out-3'), 'refund_direct', 'and the pool is not refilled by wishing');
});

test('a second payment in tops the pool back up', (t) => {
  const db = tmpDb(t, 'test-reg-refund-pool2.db');
  const rules = { ...loadRules(), refundPairs: [], suppliers: [] };
  const add = (id, date, amount, counterparty) => upsertTx(db, {
    id, account_id: 'a', account_number: '1', account_type: 'CHECKING',
    provider: 'p', date, month: date.slice(0, 7), amount, currency: 'ILS',
    counterparty, raw_desc: '', status: 'completed',
    side: amount >= 0 ? 'in' : 'out', bucket: null, bucket_group: null, raw_json: '{}',
  });
  add('in-1', '2026-01-01', 1000, 'סטודיו אורן');
  add('out-1', '2026-02-01', -600, 'סטודיו אורן');
  add('in-2', '2026-03-01', 1000, 'סטודיו אורן');
  add('out-2', '2026-04-01', -600, 'סטודיו אורן');
  classifyAll(db, rules);
  const bucketOf = (id) => db.prepare('SELECT bucket FROM bank_transactions WHERE id=?').get(id).bucket;
  assert.equal(bucketOf('out-1'), 'refund_direct');
  assert.equal(bucketOf('out-2'), 'refund_direct',
    'a genuine second payment funds a genuine second refund');
});

test('a one-word counterparty is not enough to pair on', (t) => {
  const db = tmpDb(t, 'test-reg-token.db');
  const rules = { ...loadRules(), refundPairs: [], suppliers: [] };
  const add = (id, date, amount, counterparty) => upsertTx(db, {
    id, account_id: 'a', account_number: '1', account_type: 'CHECKING',
    provider: 'p', date, month: date.slice(0, 7), amount, currency: 'ILS',
    counterparty, raw_desc: '', status: 'completed',
    side: amount >= 0 ? 'in' : 'out', bucket: null, bucket_group: null, raw_json: '{}',
  });
  add('in-1', '2026-01-01', 9000, 'משה כהן');
  add('out-1', '2026-02-01', -800, 'כהן');
  classifyAll(db, rules);
  assert.notEqual(
    db.prepare('SELECT bucket FROM bank_transactions WHERE id=?').get('out-1').bucket,
    'refund_direct',
    'a single shared surname is not a refund',
  );
});

// ---------------------------------------------------------------------------
// Card settlements. Matching only Diners and Visa meant an Isracard or Max
// consolidated debit fell through to a plain expense, on top of the individual
// card transactions already counted. The same money, twice.
// ---------------------------------------------------------------------------
test('every configured card issuer settles below the line', () => {
  const rules = loadRules();
  const expenseRules = readJson('config/expense-rules.json');
  assert.ok(rules.cardIssuers.length >= 6, 'the common Israeli issuers must ship');
  for (const issuer of rules.cardIssuers) {
    const row = {
      account_type: 'CHECKING', currency: 'ILS', amount: -25000,
      counterparty: `${issuer} חיוב חודשי`, raw_desc: '',
    };
    const res = classifyRow(row, rules, expenseRules);
    assert.equal(res.bucket, 'card_settlement', `${issuer} must be recognised as a card settlement`);
    assert.equal(res.group, 'below_line', `${issuer} must not be counted as an expense`);
  }
});

test('issuer strings are specific enough not to swallow ordinary words', () => {
  const rules = loadRules();
  const expenseRules = readJson('config/expense-rules.json');
  for (const counterparty of ['מיכאל אברהם', 'מקסימום ספורט', 'סופר ויזיה']) {
    const res = classifyRow(
      { account_type: 'CHECKING', currency: 'ILS', amount: -3000, counterparty, raw_desc: '' },
      rules, expenseRules,
    );
    assert.notEqual(res.bucket, 'card_settlement', `${counterparty} is not a credit-card issuer`);
  }
});

// ---------------------------------------------------------------------------
// PENDING de-duplication kept MAX(id) on a TEXT primary key: the largest
// string, not the newest row.
// ---------------------------------------------------------------------------
test('duplicate PENDING rows collapse to the newest, not the alphabetically last', (t) => {
  const db = tmpDb(t, 'test-reg-pending.db');
  const add = (id) => upsertTx(db, {
    id, account_id: 'a', account_number: '1', account_type: 'CHECKING',
    provider: 'p', date: '2026-08-01', month: '2026-08', amount: -500,
    currency: 'ILS', counterparty: 'הוראת קבע', raw_desc: '', status: 'PENDING',
    side: 'out', bucket: 'suppliers_other', bucket_group: 'expense', raw_json: '{}',
  });
  // Inserted oldest first. Provider ids sort the other way round, so the newest
  // row is the alphabetically smallest: exactly the case MAX(id) got wrong.
  add('zz-old');
  add('mm-newer');
  add('aa-newest');
  const { dupes } = cleanupPendingRows(db, ['zz-old', 'mm-newer', 'aa-newest']);
  const left = db.prepare("SELECT id FROM bank_transactions WHERE status='PENDING'").all();
  assert.equal(dupes, 2);
  assert.deepEqual(left.map((r) => r.id), ['aa-newest']);
});

// ---------------------------------------------------------------------------
// The template is public. Real names must never ship in it.
// ---------------------------------------------------------------------------
test('no personal data ships in the default config', () => {
  const rules = readJson('config/rules.json');
  for (const key of ['team', 'suppliers', 'refundPairs']) {
    assert.deepEqual(rules[key], [], `config/rules.json ${key} must ship empty`);
  }
});

// ---------------------------------------------------------------------------
// Supply chain: the bank-credential-holding CLI is pinned and local.
// ---------------------------------------------------------------------------
test('the financy CLI is pinned, and never fetched at run time', () => {
  const pkg = readJson('package.json');
  assert.match(pkg.dependencies.financy, /^\d+\.\d+\.\d+$/,
    'financy must be pinned to an exact version, not a range');
  assert.ok(!('xlsx' in pkg.dependencies), 'xlsx is unused and carries unfixed advisories');
  const sync = readFileSync(join(ROOT, 'scripts/financy-sync.mjs'), 'utf8');
  assert.ok(!/execFileSync\(\s*'npx'/.test(sync),
    'the sync must not resolve the CLI over the network with the client secret in scope');
  for (const script of ['dev', 'build', 'start']) {
    assert.match(pkg.scripts[script], /NEXT_TELEMETRY_DISABLED=1/,
      `npm run ${script} must not phone home: the README promises the data stays local`);
  }
});
