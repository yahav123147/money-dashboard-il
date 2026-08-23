import test from 'node:test';
import assert from 'node:assert/strict';
import { hasHeadings, findProviderOverrides, dropSnapshots } from '../lib/agent-run.mjs';
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
