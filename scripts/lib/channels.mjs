// Revenue-channel attribution. Rules live in config/channels.json; this file
// only matches. Order: product/counterparty name rules (first hit wins, in
// file order) → exact-amount rules → null.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CHANNELS_PATH = join(ROOT, 'config', 'channels.json');

export const EMPTY_RULES = { channels: [], productRules: [], bankRules: [], amountRules: [], unmatchedLabel: 'לא משויך' };

export function loadChannelRules(path = CHANNELS_PATH) {
  try { return { ...EMPTY_RULES, ...JSON.parse(readFileSync(path, 'utf8')) }; } catch { return { ...EMPTY_RULES }; }
}

const hit = (name, rules) => {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  for (const rule of rules || []) {
    const ms = Array.isArray(rule.match) ? rule.match : [rule.match];
    if (ms.some((m) => m && n.includes(String(m).toLowerCase()))) return rule.channel;
  }
  return null;
};

export function channelForProduct(name, amount, rules) {
  const byName = hit(name, rules.productRules);
  if (byName) return byName;
  const a = Math.round(Number(amount));
  for (const r of rules.amountRules || []) if (Math.round(Number(r.amount)) === a) return r.channel;
  return null;
}

export function channelForCounterparty(name, rules) {
  return hit(name, rules.bankRules);
}

// Persist a rule from the UI. kind: 'product' | 'bank' | 'amount'.
export function addChannelRule({ kind, match, amount, channel }, path = CHANNELS_PATH) {
  const cfg = loadChannelRules(path);
  if (!cfg.channels.includes(channel)) cfg.channels.push(channel);
  if (kind === 'amount') {
    cfg.amountRules = cfg.amountRules.filter((r) => Math.round(r.amount) !== Math.round(amount));
    cfg.amountRules.push({ amount: Math.round(amount), channel });
  } else {
    const key = kind === 'bank' ? 'bankRules' : 'productRules';
    const m = String(match || '').trim();
    if (!m) throw new Error('חסר טקסט להתאמה');
    cfg[key] = cfg[key].filter((r) => !(Array.isArray(r.match) ? r.match : [r.match]).includes(m));
    cfg[key].push({ match: [m], channel });
  }
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

export function setChannels(channels, path = CHANNELS_PATH) {
  const cfg = loadChannelRules(path);
  cfg.channels = [...new Set(channels.map((c) => String(c).trim()).filter(Boolean))];
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}
