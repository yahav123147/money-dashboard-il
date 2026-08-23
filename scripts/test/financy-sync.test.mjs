import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Importing the sync module must NOT start a live sync (isMain guard).
import { pickBalance, securitiesValue } from '../financy-sync.mjs';
import { parseDotEnv, getSecret } from '../lib/secrets.mjs';

test('pickBalance: card prefers ILS interimBooked, checking prefers expected', () => {
  const card = { accountType: 'CARD', balances: [
    { balanceType: 'interimBooked', balanceAmount: { currency: 'USD', amount: '10' } },
    { balanceType: 'interimBooked', balanceAmount: { currency: 'ILS', amount: '250' } },
    { balanceType: 'expected', balanceAmount: { currency: 'ILS', amount: '999' } },
  ]};
  assert.equal(pickBalance(card).balanceAmount.amount, '250');

  const checking = { accountType: 'CHECKING', balances: [
    { balanceType: 'closingBooked', balanceAmount: { currency: 'ILS', amount: '80' } },
    { balanceType: 'expected', balanceAmount: { currency: 'ILS', amount: '100' } },
    { balanceType: 'expected', creditLimitIncluded: true, balanceAmount: { currency: 'ILS', amount: '5100' } },
  ]};
  // creditLimitIncluded rows are the bank flattering itself — never the balance
  assert.equal(pickBalance(checking).balanceAmount.amount, '100');
  assert.equal(pickBalance({ accountType: 'CHECKING', balances: [] }), null);
});

test('securitiesValue: units × avg price, null when no positions', () => {
  assert.equal(securitiesValue({ securityPositions: [
    { unitsNumber: '10', averageBuyingPrice: { amount: '25.5' } },
    { unitsNumber: '2', averageBuyingPrice: { amount: '100' } },
    { unitsNumber: 'not-a-number', averageBuyingPrice: { amount: '7' } },
  ]}), 455);
  assert.equal(securitiesValue({}), null);
});

test('secrets: env var wins, then .env file; missing stays null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secrets-'));
  const envPath = join(dir, '.env');
  try {
    writeFileSync(envPath, '# comment\nFINANCY_CLIENT_ID="from-file"\nBROKEN LINE\nFINANCY_USER_ID=uid-1\n');
    assert.deepEqual(parseDotEnv('A=1\nB="two"\n#c\n'), { A: '1', B: 'two' });

    process.env.FINANCY_CLIENT_ID = 'from-env';
    try {
      assert.equal(getSecret('FINANCY_CLIENT_ID', { envPath }), 'from-env');
    } finally { delete process.env.FINANCY_CLIENT_ID; }

    assert.equal(getSecret('FINANCY_CLIENT_ID', { envPath }), 'from-file');
    assert.equal(getSecret('FINANCY_USER_ID', { envPath }), 'uid-1');
    // not in env, not in file → keychain (absent on CI/Linux) → null, never a throw
    assert.equal(getSecret('NO_SUCH_SECRET', { envPath }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('first-minute UX: missing credentials exit 1 with a Hebrew pointer, no sync attempt', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const env = { ...process.env, SECRETS_DISABLE_KEYCHAIN: '1' };
  delete env.FINANCY_CLIENT_ID; delete env.FINANCY_CLIENT_SECRET; delete env.FINANCY_USER_ID;
  // cwd is the repo root; a temp cwd is not needed — the guard exits before openDb
  let code = 0, stderr = '';
  try { await run('node', ['scripts/financy-sync.mjs'], { env }); }
  catch (e) { code = e.code; stderr = String(e.stderr); }
  assert.equal(code, 1);
  assert.ok(stderr.includes('חסרים פרטי התחברות'), 'the message must be the Hebrew pointer');
  assert.ok(stderr.includes('/setup'), 'and it must point at /setup');
});

test('saveSecret: env-file branch writes 600 and round-trips (keychain branch untouched)', async (t) => {
  const { mkdtempSync, rmSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { saveSecret, getSecret } = await import('../lib/secrets.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'save-'));
  const envPath = join(dir, '.env');
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  t.after(() => { Object.defineProperty(process, 'platform', orig); rmSync(dir, { recursive: true, force: true }); });

  assert.equal(saveSecret('FINANCY_USER_ID', 'u-42', { envPath }), 'env-file');
  assert.equal(getSecret('FINANCY_USER_ID', { envPath }), 'u-42');
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
});
