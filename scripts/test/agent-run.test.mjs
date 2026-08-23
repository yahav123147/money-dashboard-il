import test from 'node:test';
import assert from 'node:assert/strict';
import { hasHeadings, findProviderOverrides, findProviderOverridesAsync, findManagedCustomizations, findManagedCustomizationsAsync, dropSnapshots, ensureSubscription, settingsFiles, settingsFilesAsync, mdmManagedSettingsPresent, mdmManagedSettingsPresentAsync, preflight, preflightAsync, ensureConsent, runClaudeAsync, CONSENT_VERSION, claudeEnvironment, unsafeClaudeEnvNames, resolveClaudeCommand, CLAUDE_PRINT_ARGS, MAX_CLAUDE_PROMPT_BYTES } from '../lib/agent-run.mjs';
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PINNED = Object.freeze({ command: '/fixed/claude', argsPrefix: Object.freeze([]), displayPath: '/fixed/claude' });
const ensurePinnedSubscription = (options) => ensureSubscription({ claude: PINNED, ...options });
const fixtureDir = (t, prefix = 'money-agent') => {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

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
  const dir = fixtureDir(t, 'money-settings');
  const a = join(dir, 'a.json'); const b = join(dir, 'b.json'); const c = join(dir, 'c.json');
  writeFileSync(a, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://proxy', EDITOR: 'vim' } }));
  writeFileSync(b, JSON.stringify({ apiKeyHelper: '/bin/key' }));
  writeFileSync(c, JSON.stringify({ env: { EDITOR: 'vim' }, model: 'opus' }));
  const found = findProviderOverrides([a, b, c, join(dir, 'missing.json')]);
  assert.equal(found.length, 2);
  assert.ok(found[0].endsWith('env.ANTHROPIC_BASE_URL')); assert.ok(found[1].endsWith('apiKeyHelper'));
});

test('dropSnapshots removes both snapshot files', (t) => {
  const root = fixtureDir(t, 'money-snapshots');
  for (const d of ['review', 'classify']) { mkdirSync(join(root, 'data', d), { recursive: true }); writeFileSync(join(root, 'data', d, 'snapshot.json'), '{}'); }
  dropSnapshots(root);
  assert.equal(existsSync(join(root, 'data', 'review', 'snapshot.json')), false);
  assert.equal(existsSync(join(root, 'data', 'classify', 'snapshot.json')), false);
});

const MAX = () => ({ status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }) });
const quiet = (t) => { const e = console.error; console.error = () => {}; t.after(() => { console.error = e; }); };
const settingsWith = (t, obj) => { const dir = fixtureDir(t, 'money-agent-settings'); const p = join(dir, 'settings.json'); writeFileSync(p, JSON.stringify(obj)); return p; };

test('ensureSubscription: happy path on Max, clean env, no overrides', (t) => {
  quiet(t);
  assert.equal(ensurePinnedSubscription({ status: MAX, overrides: () => [], mdm: () => false, env: {}, settingsPath: settingsWith(t, {}) }), true);
});

test('ensureSubscription: refuses team/enterprise by default, accepts when listed', (t) => {
  quiet(t);
  const team = () => ({ status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'team' }) });
  assert.equal(ensurePinnedSubscription({ status: team, overrides: () => [], mdm: () => false, env: {}, settingsPath: settingsWith(t, {}) }), false);
  assert.equal(ensurePinnedSubscription({ status: team, overrides: () => [], mdm: () => false, env: {}, settingsPath: settingsWith(t, { agentsAllowedPlans: ['team'] }) }), true);
});

test('ensureSubscription: missing apiProvider, console login, or api key login are refused', (t) => {
  quiet(t);
  const st = (o) => () => ({ status: 0, stdout: JSON.stringify(o) });
  const base = { overrides: () => [], mdm: () => false, env: {}, settingsPath: settingsWith(t, {}) };
  assert.equal(ensurePinnedSubscription({ ...base, status: st({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }) }), false, 'apiProvider missing');
  assert.equal(ensurePinnedSubscription({ ...base, status: st({ loggedIn: true, authMethod: 'console', apiProvider: 'firstParty', subscriptionType: 'max' }) }), false);
  assert.equal(ensurePinnedSubscription({ ...base, status: st({ loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty' }) }), false);
  assert.equal(ensurePinnedSubscription({ ...base, status: () => ({ status: 1, stdout: '' }) }), false, 'cli failure');
  assert.equal(ensurePinnedSubscription({ ...base, status: () => ({ status: 0, stdout: 'null' }) }), false, 'non-object json');
});

test('ensureSubscription: host-managed provider env, scrub flag, MDM profile and settings overrides are refused', (t) => {
  quiet(t);
  const base = { status: MAX, overrides: () => [], mdm: () => false, env: {}, settingsPath: settingsWith(t, {}) };
  assert.equal(ensurePinnedSubscription({ ...base, env: { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' } }), false, 'host-managed routing');
  assert.equal(ensurePinnedSubscription({ ...base, env: { ANTHROPIC_BASE_URL: 'http://proxy' } }), false);
  assert.equal(ensurePinnedSubscription({ ...base, env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } }), false, 'scrubbed env cannot be trusted');
  assert.equal(ensurePinnedSubscription({ ...base, mdm: () => true }), false, 'MDM profile present');
  assert.equal(ensurePinnedSubscription({ ...base, overrides: () => ['x: apiKeyHelper'] }), false);
});

test('ensureSubscription: inside a running session only with agentsAllowInteractive', (t) => {
  quiet(t);
  for (const marker of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION']) {
    const base = { status: MAX, overrides: () => [], mdm: () => false, env: { [marker]: '1' } };
    assert.equal(ensurePinnedSubscription({ ...base, settingsPath: settingsWith(t, {}) }), false, marker);
    assert.equal(ensurePinnedSubscription({ ...base, settingsPath: settingsWith(t, { agentsAllowInteractive: true }) }), true, `${marker} explicitly allowed`);
  }
});

test('pinned Claude resolver ignores PATH, accepts official npm/native fixed candidates, and fails closed', () => {
  const executable = { isFile: () => true, mode: 0o755 };
  const npm = resolveClaudeCommand({
    candidates: ['/fixed/claude'], execPath: '/fixed/node', platform: 'linux',
    statFn: () => executable,
    realpathFn: () => '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  });
  assert.deepEqual(npm, { command: '/fixed/node', argsPrefix: ['/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js'], displayPath: '/fixed/claude' });
  const native = resolveClaudeCommand({ candidates: ['/fixed/claude'], platform: 'linux', statFn: () => executable, realpathFn: () => '/fixed/native/claude' });
  assert.deepEqual(native, { command: '/fixed/native/claude', argsPrefix: [], displayPath: '/fixed/claude' });
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  assert.throws(() => resolveClaudeCommand({ candidates: ['/fixed/claude'], statFn: () => { throw missing; } }), /נתיב התקנה קבוע/);
});

test('Claude child env pins home/temp/PATH, omits inherited OAuth, and forces every isolation flag', () => {
  const child = claudeEnvironment({
    HOME: '/attacker', TMPDIR: '/attacker/tmp', PATH: '/attacker/bin', CLAUDE_CODE_OAUTH_TOKEN: 'secret', LANG: 'he_IL.UTF-8',
  }, { platform: 'linux', home: '/Users/real' });
  assert.equal(child.HOME, '/Users/real'); assert.equal(child.TMPDIR, '/tmp'); assert.equal(child.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(child.CLAUDE_CODE_OAUTH_TOKEN, undefined); assert.equal(child.LANG, 'he_IL.UTF-8');
  for (const name of [
    'CLAUDE_CODE_DISABLE_ATTACHMENTS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
    'CLAUDE_CODE_DISABLE_POLICY_SKILLS', 'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING',
  ]) assert.equal(child[name], '1', name);
  assert.deepEqual(unsafeClaudeEnvNames({ OTEL_LOG_USER_PROMPTS: '1', https_proxy: 'http://x', NODE_OPTIONS: '--require x', SSL_CERT_FILE: '/x', DEBUG: '*' }), ['DEBUG', 'https_proxy', 'NODE_OPTIONS', 'OTEL_LOG_USER_PROMPTS', 'SSL_CERT_FILE']);
});

test('MDM probes use absolute system tools and a scrubbed env, never hostile PATH', async () => {
  const syncCalls = [];
  assert.equal(mdmManagedSettingsPresent({
    platform: 'darwin', wsl: false, env: { PATH: '/attacker' },
    spawnFn: (...args) => { syncCalls.push(args); return { status: 1, stdout: '', stderr: 'Domain does not exist' }; },
  }), false);
  assert.equal(syncCalls[0][0], '/usr/bin/defaults');
  assert.equal(syncCalls[0][2].env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');

  const winCalls = [];
  assert.equal(await mdmManagedSettingsPresentAsync({
    platform: 'win32', wsl: false, home: 'C:\\Users\\owner', env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\attacker' },
    run: async (...args) => { winCalls.push(args); return { status: 1, stdout: '', stderr: 'unable to find' }; },
  }), false);
  assert.equal(winCalls[0][0], 'C:\\Windows\\System32\\reg.exe');
  assert.equal(winCalls[0][2].env.PATH, 'C:\\Windows\\System32;C:\\Windows');
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
  const root = fixtureDir(t, 'money-preflight-sync');
  for (const d of ['review', 'classify']) { mkdirSync(join(root, 'data', d), { recursive: true }); writeFileSync(join(root, 'data', d, 'snapshot.json'), '{}'); }
  // settings path that does not exist makes ensureConsent throw inside preflight
  assert.throws(() => preflight([], { settingsPath: join(root, 'nope.json'), root }));
  assert.equal(existsSync(join(root, 'data', 'review', 'snapshot.json')), false);
});

test('env names are matched case-insensitively (Windows)', (t) => {
  quiet(t);
  const base = { status: MAX, overrides: () => [], mdm: () => false, settingsPath: settingsWith(t, {}) };
  assert.equal(ensurePinnedSubscription({ ...base, env: { anthropic_api_key: 'x' } }), false);
  assert.equal(ensurePinnedSubscription({ ...base, env: { Claude_Code_Use_Bedrock: '1' } }), false);
});

test('consent is versioned: an older consent does not cover the chat until re-approved', (t) => {
  quiet(t);
  assert.equal(ensureConsent([], settingsWith(t, { agentsSendDataToClaude: true, agentsConsentVersion: 1 })), false, 'v1 consent predates the chat');
  assert.equal(ensureConsent([], settingsWith(t, { agentsSendDataToClaude: true, agentsConsentVersion: CONSENT_VERSION })), true);
  const p = settingsWith(t, { agentsSendDataToClaude: true, agentsConsentVersion: 1 });
  assert.equal(ensureConsent(['--yes'], p), true);
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).agentsConsentVersion, CONSENT_VERSION, '--yes records the current version');
});

test('preflightAsync returns the refusal text instead of printing it, and never throws', async (t) => {
  quiet(t);
  const root = fixtureDir(t, 'money-preflight-refusal');
  const r = await preflightAsync({ settingsPath: settingsWith(t, {}), root, ttlMs: 0 });
  assert.equal(r.ok, false); assert.match(r.error, /--yes|config\/settings.json/);
});

test('ensureSubscription: a status probe that cannot run is a refusal (fail closed)', (t) => {
  quiet(t);
  const base = { overrides: () => [], mdm: () => false, env: {}, settingsPath: settingsWith(t, {}) };
  assert.equal(ensurePinnedSubscription({ ...base, status: () => ({ error: new Error('timeout'), status: null, stdout: '' }) }), false);
});

test('managed settings scans fail closed on directory and file access errors', async () => {
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  assert.throws(() => settingsFiles(ROOT, { managedDirs: ['/managed'], readdirFn: () => { throw denied; } }), /לא ניתן לסרוק/);
  await assert.rejects(settingsFilesAsync(ROOT, { managedDirs: ['/managed'], readdirFn: async () => { throw denied; } }), /לא ניתן לסרוק/);
  assert.deepEqual(findProviderOverrides(['/managed/managed-settings.json'], { readFn: () => { throw denied; } }), ['/managed/managed-settings.json: לא ניתן לקרוא']);
  assert.deepEqual(await findProviderOverridesAsync(['/managed/managed-settings.json'], { readFn: async () => { throw denied; } }), ['/managed/managed-settings.json: לא ניתן לקרוא']);
});

test('all nonempty managed policy and customization artifacts are refused, local settings stay compatible', async (t) => {
  const base = fixtureDir(t, 'money-managed-policy');
  const managed = join(base, 'managed'); const local = join(base, 'project-settings.json');
  mkdirSync(managed, { recursive: true });
  writeFileSync(join(managed, 'managed-settings.json'), '{}');
  writeFileSync(local, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://local-disabled' } }));
  assert.deepEqual(findManagedCustomizations([managed]), [], 'empty managed settings are harmless and local settings are outside the managed scan');

  writeFileSync(join(managed, 'managed-settings.json'), JSON.stringify({ theme: 'dark' }));
  mkdirSync(join(managed, 'managed-settings.d'), { recursive: true });
  writeFileSync(join(managed, 'managed-settings.d', 'policy.json'), JSON.stringify({ permissions: {} }));
  writeFileSync(join(managed, 'CLAUDE.md'), 'managed instructions');
  for (const dir of ['hooks', 'plugins', 'skills']) { mkdirSync(join(managed, dir), { recursive: true }); writeFileSync(join(managed, dir, 'artifact'), 'x'); }
  const syncFound = findManagedCustomizations([managed]);
  const asyncFound = await findManagedCustomizationsAsync([managed]);
  for (const marker of ['managed-settings.json', 'policy.json', 'CLAUDE.md', 'hooks', 'plugins', 'skills']) {
    assert.ok(syncFound.some((x) => x.includes(marker)), marker);
    assert.ok(asyncFound.some((x) => x.includes(marker)), `async ${marker}`);
  }
  assert.ok(findProviderOverrides([local]).some((x) => x.includes('ANTHROPIC_BASE_URL')), 'the local file is detectable but intentionally not part of managed policy enforcement');
});

test('async host policy probes use injected commands and fail closed', async () => {
  const macCalls = [];
  const cleanMac = await mdmManagedSettingsPresentAsync({
    platform: 'darwin', wsl: false,
    run: async (...args) => { macCalls.push(args); return { status: 1, stdout: '', stderr: 'Domain com.anthropic.claudecode does not exist' }; },
  });
  assert.equal(cleanMac, false); assert.equal(macCalls.length, 1);
  assert.equal(await mdmManagedSettingsPresentAsync({ platform: 'darwin', wsl: false, run: async () => ({ status: null, error: new Error('timeout'), stdout: '', stderr: '' }) }), true);
  const winCalls = [];
  assert.equal(await mdmManagedSettingsPresentAsync({
    platform: 'win32', wsl: false, home: 'C:\\Users\\owner', env: { SystemRoot: 'C:\\Windows' },
    run: async (...args) => { winCalls.push(args); return { status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key' }; },
  }), false);
  assert.equal(winCalls.length, 2, 'both HKLM and HKCU are checked asynchronously');
});

test('preflightAsync has no global console capture and does not cache consent or provider decisions', async (t) => {
  const root = fixtureDir(t, 'money-preflight-async');
  const settingsPath = settingsWith(t, { agentsSendDataToClaude: true, agentsConsentVersion: CONSENT_VERSION });
  let providerOverrides = [];
  let statusCalls = 0;
  const deps = {
    settingsPath, root, env: {},
    resolveClaude: () => PINNED,
    status: async () => { statusCalls += 1; await new Promise((resolve) => setImmediate(resolve)); return MAX(); },
    overrides: async () => providerOverrides,
    mdm: async () => false,
  };
  const seen = [];
  const original = console.error;
  console.error = (...args) => { seen.push(args.join(' ')); };
  try {
    const pending = preflightAsync(deps);
    console.error('parallel sentinel');
    const allowed = await pending;
    assert.equal(allowed.ok, true); assert.equal(allowed.claude, PINNED);
    assert.equal(allowed.claudeEnv.CLAUDE_CODE_DISABLE_ATTACHMENTS, '1');
  } finally { console.error = original; }
  assert.deepEqual(seen, ['parallel sentinel'], 'another request log is neither swallowed nor returned by preflight');

  providerOverrides = ['managed-settings.json: apiKeyHelper'];
  const providerRefusal = await preflightAsync(deps);
  assert.equal(providerRefusal.ok, false); assert.match(providerRefusal.error, /apiKeyHelper/);
  assert.equal(statusCalls, 2, 'provider state is checked again instead of using a positive gate cache');

  providerOverrides = [];
  writeFileSync(settingsPath, JSON.stringify({ agentsSendDataToClaude: false, agentsConsentVersion: CONSENT_VERSION }));
  const consentRefusal = await preflightAsync(deps);
  assert.equal(consentRefusal.ok, false); assert.match(consentRefusal.error, /--yes|agentsSendDataToClaude/);
  assert.equal(statusCalls, 2, 'revoked consent is observed before another auth probe');
});

test('preflightAsync refuses a managed settings scan error without invoking Claude', async (t) => {
  const root = fixtureDir(t, 'money-preflight-scan');
  let statusCalls = 0;
  const result = await preflightAsync({
    settingsPath: settingsWith(t, { agentsSendDataToClaude: true, agentsConsentVersion: CONSENT_VERSION }),
    root, env: {}, status: async () => { statusCalls += 1; return MAX(); },
    resolveClaude: () => PINNED,
    overrides: async () => { throw new Error('managed-settings.d denied'); },
    mdm: async () => false,
  });
  assert.equal(result.ok, false); assert.match(result.error, /managed-settings\.d denied/);
  assert.equal(statusCalls, 1, 'only the injected fake auth probe ran');
});

test('preflightAsync returns a refusal even when snapshot cleanup throws', async (t) => {
  const result = await preflightAsync({
    settingsPath: settingsWith(t, { agentsSendDataToClaude: false, agentsConsentVersion: CONSENT_VERSION }),
    root: fixtureDir(t, 'money-cleanup-failure'),
    cleanup: () => { throw new Error('snapshot permission denied'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /agentsSendDataToClaude|--yes/);
  assert.match(result.error, /snapshot permission denied/);
});

test('runClaudeAsync caps combined UTF-8 stdout and stderr and waits for killed child close', async () => {
  let closed = false; let killed = false;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {
      killed = true;
      setTimeout(() => { closed = true; child.emit('close', null); }, 20);
      return true;
    };
    setImmediate(() => {
      child.stdout.write(Buffer.alloc(700, 97));
      child.stderr.write(Buffer.from('₪'.repeat(200))); // 600 UTF-8 bytes, total 1300
    });
    return child;
  };
  const result = await runClaudeAsync('fake prompt', { claude: PINNED, claudeEnv: { PATH: '/safe' }, spawnFn, maxBytes: 1024, timeoutMs: 1000, killGraceMs: 200 });
  assert.deepEqual(result, { ok: false, error: 'הפלט גדול מדי' });
  assert.equal(killed, true); assert.equal(closed, true, 'resolution waits for close after SIGKILL');

  const success = await runClaudeAsync('fake prompt', {
    claude: PINNED, claudeEnv: { PATH: '/safe' },
    timeoutMs: 1000,
    spawnFn: () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => true;
      setImmediate(() => { child.stdout.write('תשובה'); child.emit('close', 0); });
      return child;
    },
  });
  assert.deepEqual(success, { ok: true, text: 'תשובה' });
});

test('runClaudeAsync uses the pinned command, isolation args and exact preflight env; oversized input never spawns', async () => {
  const exactEnv = { PATH: '/safe', CLAUDE_CODE_DISABLE_ATTACHMENTS: '1' };
  let call; let spawnCount = 0;
  const spawnFn = (command, args, options) => {
    spawnCount += 1; call = { command, args, options };
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    setImmediate(() => { child.stdout.write('ok'); child.emit('close', 0); });
    return child;
  };
  assert.deepEqual(await runClaudeAsync('hello', { claude: PINNED, claudeEnv: exactEnv, spawnFn, timeoutMs: 1000 }), { ok: true, text: 'ok' });
  assert.equal(call.command, PINNED.command); assert.equal(call.options.env, exactEnv);
  for (const arg of ['--disable-slash-commands', '--no-chrome', '--setting-sources']) assert.ok(call.args.includes(arg));
  assert.deepEqual(CLAUDE_PRINT_ARGS.filter((arg) => arg.startsWith('--disable-') || arg === '--no-chrome'), ['--disable-slash-commands', '--no-chrome']);
  const tooLarge = await runClaudeAsync('x'.repeat(MAX_CLAUDE_PROMPT_BYTES + 1), { claude: PINNED, claudeEnv: exactEnv, spawnFn });
  assert.equal(tooLarge.inputRejected, true); assert.equal(spawnCount, 1, 'oversized input is rejected before spawn');
});

test('Ask prompt is API-only; there is no interactive /ask skill', () => {
  assert.equal(existsSync(join(ROOT, '.claude', 'skills', 'ask', 'SKILL.md')), false);
  assert.equal(existsSync(join(ROOT, 'scripts', 'prompts', 'ask.md')), true);
  assert.match(readFileSync(join(ROOT, 'app', 'api', 'ask', 'route.js'), 'utf8'), /scripts.*prompts.*ask\.md/);
});
