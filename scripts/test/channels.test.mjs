import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { channelForProduct, channelForCounterparty, addChannelRule, setChannels, loadChannelRules, EMPTY_RULES } from '../lib/channels.mjs';

const RULES = {
  ...EMPTY_RULES,
  channels: ['קורסים', 'מנויים'],
  productRules: [{ match: ['קורס'], channel: 'קורסים' }, { match: ['מנוי'], channel: 'מנויים' }],
  bankRules: [{ match: ['לקוח א'], channel: 'קורסים' }],
  amountRules: [{ amount: 199, channel: 'מנויים' }],
};

test('channelForProduct: name rule first, then exact amount, else null', () => {
  assert.equal(channelForProduct('הקורס הגדול', 999, RULES), 'קורסים');
  assert.equal(channelForProduct('MNUY basic', 199, RULES), 'מנויים');
  assert.equal(channelForProduct('', 199, RULES), 'מנויים');
  assert.equal(channelForProduct('משהו אחר', 77, RULES), null);
});

test('channelForCounterparty is substring, case-insensitive', () => {
  assert.equal(channelForCounterparty('העברה מלקוח א בע"מ', RULES), 'קורסים');
  assert.equal(channelForCounterparty('לקוח ב', RULES), null);
});

test('addChannelRule / setChannels persist and replace', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'ch-')), 'channels.json');
  writeFileSync(p, JSON.stringify(EMPTY_RULES));
  setChannels(['א', 'ב', 'א'], p);
  assert.deepEqual(loadChannelRules(p).channels, ['א', 'ב']);
  addChannelRule({ kind: 'product', match: 'סדנה', channel: 'ג' }, p);
  addChannelRule({ kind: 'product', match: 'סדנה', channel: 'א' }, p); // re-assign replaces
  addChannelRule({ kind: 'amount', amount: 59, channel: 'ב' }, p);
  const cfg = loadChannelRules(p);
  assert.deepEqual(cfg.channels, ['א', 'ב', 'ג']);
  assert.deepEqual(cfg.productRules, [{ match: ['סדנה'], channel: 'א' }]);
  assert.deepEqual(cfg.amountRules, [{ amount: 59, channel: 'ב' }]);
  assert.throws(() => addChannelRule({ kind: 'bank', match: '', channel: 'א' }, p));
});

test('template ships with no channels and no rules', () => {
  const cfg = JSON.parse(readFileSync(new URL('../../config/channels.json', import.meta.url), 'utf8'));
  assert.deepEqual(cfg.channels, []);
  assert.deepEqual(cfg.productRules, []);
  assert.deepEqual(cfg.bankRules, []);
});
