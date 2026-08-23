// In-app onboarding: validation, config writes, secrets routed through saveSecret.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validate, applySetup, setupStatus } from '../lib/setup.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function tmpRoot() {
  const d = mkdtempSync(join(tmpdir(), 'money-setup-'));
  mkdirSync(join(d, 'config'));
  for (const f of ['settings.json', 'cardcom.json']) cpSync(join(ROOT, 'config', f), join(d, 'config', f));
  return d;
}

test('validate rejects a missing entity and half-filled key sets', () => {
  assert.throws(() => validate({}), /סוג עסק/);
  assert.throws(() => validate({ entityType: 'murshe', financy: { clientId: 'a' } }), /Financy/);
  assert.throws(() => validate({ entityType: 'murshe', cardcom: { apiName: 'a' } }), /קארדקום/);
  assert.throws(() => validate({ entityType: 'murshe', advanceRatePct: 99 }), /שיעור מקדמה/);
});

test('validate: company has no credit points; blanks become null', () => {
  const v = validate({ entityType: 'company', advanceRatePct: '', creditPoints: '3' });
  assert.equal(v.advanceRatePct, null);
  assert.equal(v.creditPoints, null);
  assert.equal(v.flagThresholdIls, 5000);
  assert.equal(validate({ entityType: 'patur', creditPoints: '2.75' }).creditPoints, 2.75);
});

test('applySetup writes settings + cardcom config and routes secrets through saveSecret', () => {
  const root = tmpRoot();
  const saved = {};
  const saveSecret = (k, v) => { saved[k] = v; return 'test-store'; };
  const out = applySetup({
    entityType: 'patur', advanceRatePct: '4.5', creditPoints: '2.25',
    financy: { clientId: 'CID-9f1', clientSecret: 'SECRET-7ab', userId: 'UID-3cd' },
    cardcom: { apiName: 'APINAME-55e', apiPassword: 'PW-81q', productFieldId: '31' },
  }, { root, saveSecret });
  const s = JSON.parse(readFileSync(join(root, 'config', 'settings.json'), 'utf8'));
  assert.equal(s.entityType, 'patur');
  assert.equal(s.vatRate, 1.0);
  assert.equal(s.advanceRatePct, 4.5);
  assert.equal(s.creditPoints, 2.25);
  const c = JSON.parse(readFileSync(join(root, 'config', 'cardcom.json'), 'utf8'));
  assert.equal(c.enabled, true);
  assert.equal(c.productFieldId, 31);
  assert.deepEqual(Object.keys(saved).sort(), ['CARDCOM_API_NAME', 'CARDCOM_API_PASSWORD', 'FINANCY_CLIENT_ID', 'FINANCY_CLIENT_SECRET', 'FINANCY_USER_ID']);
  // response never carries the secret values
  assert.ok(!JSON.stringify(out).includes('SECRET-7ab') && !JSON.stringify(out).includes('PW-81q'));
  // secrets never land in config files
  const cfgText = readFileSync(join(root, 'config', 'settings.json'), 'utf8') + readFileSync(join(root, 'config', 'cardcom.json'), 'utf8');
  for (const v of Object.values(saved)) assert.ok(!cfgText.includes(v));
});

test('applySetup without cardcom disables the module; status reflects config', () => {
  const root = tmpRoot();
  applySetup({ entityType: 'murshe' }, { root, saveSecret: () => 'x' });
  const st = setupStatus({ root, getSecret: () => null });
  assert.equal(st.configured, true);
  assert.equal(st.cardcomEnabled, false);
  assert.equal(st.hasFinancy, false);
});

test('fresh template reports configured=false', () => {
  const st = setupStatus({ root: tmpRoot(), getSecret: () => null });
  assert.equal(st.configured, false);
});
