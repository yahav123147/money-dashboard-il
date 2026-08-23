// Card-expense sub-classification: one module, data in config/expense-rules.json.
// Only CARD rows get a sub_bucket — CHECKING rows are already well bucketed.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULES_PATH = join(ROOT, 'config', 'expense-rules.json');

// these three leave operating profit (owner's decision 10.08)
export const BELOW_LINE_SUBS = ['personal', 'charity', 'other_venture'];

export const CATEGORY_LABELS = {
  ads: 'פרסום',
  profit_share: 'תגמול מנהלים',
  tools: 'תוכנות וכלים',
  fulfillment: 'משלוחים והפצה',
  processing: 'עמלות סליקה',
  other_business: 'אחר עסקי',
  personal: 'פרטי',
  charity: 'תרומות',
  other_venture: 'עסק אחר',
};

export function loadExpenseRules(path = RULES_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Case-insensitive substring match on counterparty, first rule wins.
// Returns { sub, channel } — never null; unmatched gets the configured default.
export function subBucketFor(counterparty, rules) {
  const name = (counterparty || '').toLowerCase();
  if (name) {
    for (const rule of rules.rules) {
      if ((rule.match || []).some((m) => name.includes(m.toLowerCase()))) {
        return { sub: rule.sub, channel: rule.channel || null };
      }
    }
  }
  return { sub: rules.defaultSub, channel: null };
}
