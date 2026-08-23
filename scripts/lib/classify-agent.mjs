// The classification agent's plumbing: what to show it, how to read what it
// proposes, and how an approved proposal becomes a permanent rule. The agent
// itself (Claude, through the user's subscription) only ever sees the
// groups below and returns JSON; every write goes through applyProposal,
// after a person approved it in the dashboard or in /classify.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from './classify.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RULES_PATH = join(ROOT, 'config', 'rules.json');

// The vocabulary the agent may use for bank rows. Anything else is rejected.
export const BANK_BUCKETS = {
  out: {
    team: { group: 'expense', label: 'שכר / צוות' },
    rent: { group: 'expense', label: 'שכירות' },
    suppliers_other: { group: 'expense', label: 'ספקים ושירותים' },
    tax_vat: { group: 'expense', label: 'מע"מ' },
    tax_advance: { group: 'expense', label: 'מקדמות מס הכנסה' },
    tax_withholding: { group: 'expense', label: 'ניכויים במקור' },
    tax_social: { group: 'expense', label: 'ביטוח לאומי' },
    pension: { group: 'expense', label: 'פנסיה / קופות' },
    card_settlement: { group: 'below_line', label: 'חיוב כרטיס אשראי (נספר בכרטיס)' },
    owner_draw: { group: 'below_line', label: 'משיכת בעלים / פרטי' },
    invest: { group: 'below_line', label: 'השקעה / חיסכון' },
    loan_repayment: { group: 'below_line', label: 'החזר הלוואה' },
    refund_direct: { group: 'refund', label: 'החזר ללקוח' },
  },
  in: {
    direct: { group: 'revenue', label: 'הכנסה מלקוח' },
    other_revenue: { group: 'revenue', label: 'הכנסה אחרת' },
    loan_in: { group: 'below_line', label: 'הלוואה שהתקבלה' },
    owner_deposit: { group: 'below_line', label: 'הפקדת בעלים' },
    tax_refund: { group: 'below_line', label: 'החזר מס' },
  },
};

// Unclassified bank rows, grouped by counterparty, newest first by weight.
export function gatherUnclassified(db, { limit = 40 } = {}) {
  const rows = db.prepare(`
    SELECT counterparty, raw_desc, amount, date FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS' AND bucket_group='unclassified'
    ORDER BY date DESC
  `).all();
  const groups = new Map();
  for (const r of rows) {
    const key = (r.counterparty || r.raw_desc || '').trim();
    if (!key) continue;
    const g = groups.get(key) || { counterparty: key, side: r.amount >= 0 ? 'in' : 'out', count: 0, total: 0, first: r.date, last: r.date, samples: [] };
    g.count += 1; g.total += r.amount;
    if (r.date < g.first) g.first = r.date;
    if (r.date > g.last) g.last = r.date;
    if (g.samples.length < 3) g.samples.push({ date: r.date, amount: Math.round(r.amount), desc: (r.raw_desc || '').slice(0, 80) });
    groups.set(key, g);
  }
  const all = [...groups.values()].map((g) => ({ ...g, total: Math.round(g.total) }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  return { groups: all.slice(0, limit), totalGroups: all.length, totalRows: rows.length, totalAmount: Math.round(rows.reduce((s, r) => s + r.amount, 0)) };
}

// Existing rules as examples, so the agent mirrors the house style.
export function ruleExamples(rules = loadRules()) {
  const ex = [];
  for (const r of rules.outflows || []) if (r.match) ex.push({ side: 'out', match: r.match, bucket: r.bucket });
  for (const r of rules.inflows || []) if (r.match) ex.push({ side: 'in', match: r.match, bucket: r.bucket });
  return ex.slice(-12);
}

// Parse the agent's answer: a JSON array (optionally fenced). Drops anything
// outside the vocabulary or not in the offered groups.
export function parseProposals(text, groups) {
  const m = String(text || '').match(/```json\s*([\s\S]*?)```/) || String(text || '').match(/(\[[\s\S]*\])/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[1]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const byName = new Map(groups.map((g) => [g.counterparty, g]));
  const out = [];
  for (const p of arr) {
    const g = byName.get(String(p.counterparty || '').trim());
    if (!g) continue;
    const vocab = BANK_BUCKETS[g.side];
    if (!vocab[p.bucket]) continue;
    const match = String(p.match || g.counterparty).trim();
    if (!match || !g.counterparty.includes(match)) continue;
    out.push({
      counterparty: g.counterparty, side: g.side, count: g.count, total: g.total,
      bucket: p.bucket, group: vocab[p.bucket].group, label: vocab[p.bucket].label,
      match, reason: String(p.reason || '').slice(0, 200),
      confidence: ['high', 'medium', 'low'].includes(p.confidence) ? p.confidence : 'medium',
      status: 'pending',
    });
  }
  return out;
}

// Write one approved proposal as a rule and re-run the classifier.
export function applyProposal(db, { side, match, bucket }, path = RULES_PATH) {
  const vocab = BANK_BUCKETS[side];
  if (!vocab || !vocab[bucket]) throw new Error('קטגוריה לא מוכרת');
  const m = String(match || '').trim();
  if (m.length < 2) throw new Error('טקסט התאמה קצר מדי');
  const rules = JSON.parse(readFileSync(path, 'utf8'));
  const key = side === 'in' ? 'inflows' : 'outflows';
  rules[key] = Array.isArray(rules[key]) ? rules[key] : [];
  // One rule per match text; a newer decision replaces an older one.
  rules[key] = rules[key].filter((r) => !(Array.isArray(r.match) && r.match.length === 1 && r.match[0] === m));
  rules[key].push({ match: [m], bucket, group: vocab[bucket].group, source: 'classify' });
  writeFileSync(path, JSON.stringify(rules, null, 2) + '\n');
  // Only the rows this rule is about, and only the ones still unclassified.
  // A full re-run would also rewrite rows classified some other way.
  const n = db.prepare(`
    UPDATE bank_transactions SET bucket=?, bucket_group=?, updated_at=datetime('now')
    WHERE account_type='CHECKING' AND currency='ILS' AND bucket_group='unclassified'
      AND ((? = 'in' AND amount >= 0) OR (? = 'out' AND amount < 0))
      AND instr(COALESCE(counterparty,'') || ' ' || COALESCE(raw_desc,''), ?) > 0
  `).run(bucket, vocab[bucket].group, side, side, m).changes;
  return { rule: { match: [m], bucket, group: vocab[bucket].group }, reclassified: n };
}
