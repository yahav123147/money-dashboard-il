import test from 'node:test';
import assert from 'node:assert/strict';
import { hasHeadings, findProviderOverrides, dropSnapshots, ensureSubscription, settingsFiles, preflight } from '../lib/agent-run.mjs';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const H = ['### השורה התחתונה', '### מה נראה לא נכון', '### מה לתקן', '### שאלות לבעל העסק'];

test('hasHeadings: each heading on its own line, in order', () => {
  assert.equal(hasHeadings('### השורה התחתונה\nטקסט\n### מה נראה לא נכון\n- א\n### מה לתקן\n- ב\n### שאלות לבעל העסק\nאין.', H), true);
  assert.equal(hasHeadings('הכותרות הן ### השורה התחתונה ### מה נראה לא נכון ### מה לתקן ### שאלות לבעל העסק בשורה אחת', H), false, 'mentions are not headings');
  assert.equal(hasHeadings('### מה לתקן\n### השורה התחתונה\n### מה נראה לא נכון\n### שאלות לבעל העסק', H), false, 'wrong order');
  assert.equal(hasHeadings('### השורה התחתונה\n### מה נראה לא נכון\n### מה לתקן', H), false, 'missing one');
});

test('hasHeadings: headings alone, or a stray heading before ours, are rejected', () => {
  assert.equal(hasHeadings('### השורה התחתונה\n### מה נראה לא נכון\n### מה לתקן\n### שאלות לבעל העסק', H), false, 'no content');
  assert.equal(hasHeadings('### הקדמה\nטקסט\n### השורה התחתונה\nא\n### מה נראה לא נכון\nב\n### מה לתקן\nג\n### שאלות לבעל העסק\nד', H), false, 'extra heading first');
  assert.equal(hasHeadings('### השורה התחתונה\nא\n### מה נראה לא נכון\nב\n### מה לתקן\nג\n### שאלות לבעל העסק\n', H), false, 'last section empty');
  assert.equal(hasHeadings('\n### השורה התחתונה\nא\n### מה נראה לא נכון\n- ב\n### מה לתקן\n- ג\n### שאלות לבעל העסק\nאין.\n', H), true);
});

test('findProviderOverrides flags env.ANTHROPIC_* and apiKeyHelper in settings files', (t) => {
  const dir = join(ROOT, 'data', 'test-settings');
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = join(dir, 'a.json'); const b = join(dir, 'b.json'); const c = join(dir, 'c.json');
  writeFileSync(a, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://proxy', EDITOR: 'vim' } }));
  writeFileSync(b, JSON.stringify({ apiKeyHelper: '/bin/key' }));
  writeFileSync(c, JSON.stringify({ env: { EDITOR: 'vim' }, model: 'opus' }));
  const found = findProviderOverrides([a, b, c, join(dir, 'missing.json')]);
  assert.equal(found.length, 2);
  assert.ok(found[0].endsWith('env.ANTHROPIC_BASE_URL')); assert.ok(found[1].endsWith('apiKeyHelper'));
});

test('dropSnapshots removes both snapshot files', (t) => {
  const root = join(ROOT, 'data', 'test-root');
  for (const d of ['review', 'classify']) { mkdirSync(join(root, 'data', d), { recursive: true }); writeFileSync(join(root, 'data', d, 'snapshot.json'), '{}'); }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  dropSnapshots(root);
  assert.equal(existsSync(join(root, 'data', 'review', 'snapshot.json')), false);
  assert.equal(existsSync(join(root, 'data', 'classify', 'snapshot.json')), false);
});

const MAX = () => ({ status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }) });
const quiet = (t) => { const e = console.error; console.error = () => {}; t.after(() => { console.error = e; }); };
const settingsWith = (t, obj) => { const dir = join(ROOT, 'data', 'test-agent-settings'); mkdirSync(dir, { recursive: true }); const p = join(dir, `s-${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify(obj)); t.after(() => rmSync(p, { force: true })); return p; };

test('ensureSubscription: happy path on Max, clean env, no overrides', (t) => {
  quiet(t);
  assert.equal(ensureSubscription({ status: MAX, overrides: () => [], mdm: () => false, env: {}, settingsPath: settingsWith(t, {}) }), true);
});

test('ensureSubscription: refuses team/enterprise by default, accepts when listed', (t) => {
  quiet(t);
  const team = () => ({ status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'team' }) });
  assert.equal(ensureSubscription({ status: team, overrides: () => [], mdm: () => false, env: {}, settingsPath: settingsWith(t, {}) }), false);
  assert.equal(ensureSubscription({ status: team, overrides: () => [], mdm: () => false, env: {}, settingsPath: settingsWith(t, { agentsAllowedPlans: ['team'] }) }), true);
});

test('ensureSubscription: missing apiProvider, console login, or api key login are refused', (t) => {
  quiet(t);
  const st = (o) => () => ({ status: 0, stdout: JSON.stringify(o) });
  const base = { overrides: () => [], mdm: () => false, env: {}, settingsPath: settingsWith(t, {}) };
  assert.equal(ensureSubscription({ ...base, status: st({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }) }), false, 'apiProvider missing');
  assert.equal(ensureSubscription({ ...base, status: st({ loggedIn: true, authMethod: 'console', apiProvider: 'firstParty', subscriptionType: 'max' }) }), false);
  assert.equal(ensureSubscription({ ...base, status: st({ loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty' }) }), false);
  assert.equal(ensureSubscription({ ...base, status: () => ({ status: 1, stdout: '' }) }), false, 'cli failure');
  assert.equal(ensureSubscription({ ...base, status: () => ({ status: 0, stdout: 'null' }) }), false, 'non-object json');
});

test('ensureSubscription: host-managed provider env, scrub flag, MDM profile and settings overrides are refused', (t) => {
  quiet(t);
  const base = { status: MAX, overrides: () => [], mdm: () => false, env: {}, settingsPath: settingsWith(t, {}) };
  assert.equal(ensureSubscription({ ...base, env: { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' } }), false, 'host-managed routing');
  assert.equal(ensureSubscription({ ...base, env: { ANTHROPIC_BASE_URL: 'http://proxy' } }), false);
  assert.equal(ensureSubscription({ ...base, env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } }), false, 'scrubbed env cannot be trusted');
  assert.equal(ensureSubscription({ ...base, mdm: () => true }), false, 'MDM profile present');
  assert.equal(ensureSubscription({ ...base, overrides: () => ['x: apiKeyHelper'] }), false);
});

test('ensureSubscription: inside a running session only with agentsAllowInteractive', (t) => {
  quiet(t);
  const base = { status: MAX, overrides: () => [], mdm: () => false, env: { CLAUDECODE: '1' } };
  assert.equal(ensureSubscription({ ...base, settingsPath: settingsWith(t, {}) }), false);
  assert.equal(ensureSubscription({ ...base, settingsPath: settingsWith(t, { agentsAllowInteractive: true }) }), true);
});

test('findProviderOverrides: policyHelper is an override; settingsFiles include managed drop-ins', (t) => {
  const p = settingsWith(t, { policyHelper: '/bin/policy' });
  assert.ok(findProviderOverrides([p])[0].endsWith('policyHelper'));
  const files = settingsFiles();
  assert.ok(files.some((f) => f.includes('managed-settings.json')));
  assert.ok(files.some((f) => f.endsWith('.claude/settings.json')));
});

test('preflight drops snapshots even when a check throws', (t) => {
  quiet(t);
  const root = join(ROOT, 'data', 'test-root2');
  for (const d of ['review', 'classify']) { mkdirSync(join(root, 'data', d), { recursive: true }); writeFileSync(join(root, 'data', d, 'snapshot.json'), '{}'); }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // settings path that does not exist makes ensureConsent throw inside preflight
  assert.throws(() => preflight([], { settingsPath: join(root, 'nope.json'), root }));
  assert.equal(existsSync(join(root, 'data', 'review', 'snapshot.json')), false);
});
