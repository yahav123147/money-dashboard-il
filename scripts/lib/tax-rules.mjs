// Israeli income-tax recognition rules. Data lives in config/tax-rules.json —
// edit there, not here. This module only matches counterparties to rules and
// reports what it CANNOT compute, which is as important as what it can.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TAX_RULES_PATH = join(ROOT, 'config', 'tax-rules.json');

export function loadTaxRules(path = TAX_RULES_PATH) {
  const r = JSON.parse(readFileSync(path, 'utf8'));
  const ratio = r.homeOffice?.businessRatio;
  // null = not configured yet (the setup skill fills it). Only a PRESENT bad
  // value is an error — a fresh install must not 500 on /api/tax.
  if (ratio != null && !(ratio > 0 && ratio <= 1)) {
    throw new Error(`tax-rules.json: homeOffice.businessRatio must be in (0,1] or null, got ${ratio}`);
  }
  for (const rule of r.recognition || []) {
    if (rule.rate !== null && !(rule.rate >= 0 && rule.rate <= 1)) {
      throw new Error(`tax-rules.json: ${rule.key} rate must be in [0,1] or null, got ${rule.rate}`);
    }
  }
  return r;
}

const hit = (name, list) => {
  const n = (name || '').trim().toLowerCase();
  if (!n) return false;
  return (list || []).some((m) => n.includes(String(m).toLowerCase()));
};

// Which recognition rule applies to a counterparty, and at what rate.
// Returns { key, label, rate, computable } — rate null means the rule exists
// but the deductible amount cannot be derived from a bank row alone.
export function recognitionFor(counterparty, rules) {
  if (rules.homeOffice?.businessRatio != null
      && hit(counterparty, rules.homeOffice?.matchCounterparty)) {
    return {
      key: 'home_office',
      label: 'משרד בבית — לפי יחס שטח',
      rate: rules.homeOffice.businessRatio,
      computable: true,
    };
  }
  for (const rule of rules.recognition || []) {
    if (!rule.matchCounterparty) continue;
    if (!hit(counterparty, rule.matchCounterparty)) continue;
    return {
      key: rule.key,
      label: rule.label,
      rate: rule.rate,
      computable: rule.rate !== null && !rule._cannotCompute,
    };
  }
  return null;
}
