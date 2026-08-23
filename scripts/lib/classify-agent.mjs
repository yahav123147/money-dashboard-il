// The classification agent's plumbing: what to show it, how to read what it
// proposes, and how an approved proposal becomes a permanent rule. The agent
// itself (Claude, through the user's subscription) only ever sees the
// groups below and returns JSON; every write goes through applyProposal,
// after a person approved it in the dashboard or in /classify.
import { loadRules, explicitRules } from './classify.mjs';


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
    const name = (r.counterparty || r.raw_desc || '').trim();
    if (!name) continue;
    const side = r.amount >= 0 ? 'in' : 'out';
    const key = side + '|' + name; // the same name can be a client and a supplier
    const g = groups.get(key) || { counterparty: name, side, count: 0, total: 0, first: r.date, last: r.date, samples: [] };
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
export function ruleExamples(db, rules = loadRules()) {
  const ex = [];
  if (db) for (const r of explicitRules(db)) ex.push({ side: r.side, match: [r.match], bucket: r.bucket });
  for (const r of rules.outflows || []) if (r.match) ex.push({ side: 'out', match: r.match, bucket: r.bucket });
  for (const r of rules.inflows || []) if (r.match) ex.push({ side: 'in', match: r.match, bucket: r.bucket });
  return ex.slice(-12);
}

// Parse the agent's answer: a JSON array (optionally fenced). Drops anything
// outside the vocabulary or not in the offered groups. Returns null when
// there is no JSON array at all (a broken answer), [] when the agent
// legitimately proposed nothing.
export function parseProposals(text, groups) {
  const m = String(text || '').match(/```json\s*([\s\S]*?)```/) || String(text || '').match(/(\[[\s\S]*\])/);
  if (!m) return null;
  let arr;
  try { arr = JSON.parse(m[1]); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const byKey = new Map(groups.map((g) => [g.side + '|' + g.counterparty, g]));
  const out = [];
  for (const p of arr) {
    if (!p || typeof p !== 'object') continue;
    // side is part of the contract: the same name can be a client and a supplier
    if (p.side !== 'in' && p.side !== 'out') continue;
    const name = String(p.counterparty || '').trim();
    const g = byKey.get(p.side + '|' + name);
    if (!g) continue;
    const vocab = BANK_BUCKETS[g.side];
    if (typeof p.bucket !== 'string' || !Object.hasOwn(vocab, p.bucket)) continue;
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

// One approved proposal = one SQLite transaction: the rule row and the
// history update commit together or not at all. No file, no lock file, no
// window between "rows classified" and "rule published". The history update
// is by exact name + direction, and only rows still unclassified.
export function applyProposal(db, { side, match, bucket, counterparty }) {
  if (side !== 'in' && side !== 'out') throw new Error('כיוון לא תקין');
  const vocab = BANK_BUCKETS[side];
  if (typeof bucket !== 'string' || !Object.hasOwn(vocab, bucket)) throw new Error('קטגוריה לא מוכרת');
  const { group } = vocab[bucket];
  const name = String(counterparty || '').trim();
  if (!name) throw new Error('חסר שם מוטב');
  const m = String(match || '').trim();
  if (m.length < 2) throw new Error('טקסט התאמה קצר מדי');
  // A rule that does not match its own counterparty would be undone by the
  // next full reclassify; refuse it here, not only in the parser.
  if (!name.includes(m)) throw new Error('טקסט ההתאמה חייב להופיע בשם המוטב');
  const n = db.transaction(() => {
    const priority = db.prepare('SELECT COALESCE(MAX(priority), 0) + 1 p FROM classify_rules').get().p;
    db.prepare(`
      INSERT INTO classify_rules (side, match, bucket, bucket_group, counterparty, created_at, priority)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(side, match) DO UPDATE SET bucket=excluded.bucket, bucket_group=excluded.bucket_group, counterparty=excluded.counterparty, created_at=excluded.created_at, priority=excluded.priority
    `).run(side, m, bucket, group, name, priority);
    return db.prepare(`
      UPDATE bank_transactions SET bucket=?, bucket_group=?, updated_at=datetime('now')
      WHERE account_type='CHECKING' AND currency='ILS' AND bucket_group='unclassified'
        AND ((? = 'in' AND amount >= 0) OR (? = 'out' AND amount < 0))
        AND TRIM(COALESCE(counterparty, raw_desc, '')) = ?
    `).run(bucket, group, side, side, name).changes;
  }).immediate();
  return { rule: { match: [m], bucket, group }, reclassified: n };
}

// The explicit rules, newest decision first, for the panel.
export function listRules(db) {
  return db.prepare('SELECT side, match, bucket, bucket_group AS "group", counterparty, created_at AS createdAt, priority FROM classify_rules ORDER BY priority DESC').all();
}

// Undo a rule: delete it and put the rows it classified back to unclassified
// (by exact counterparty + direction + bucket, only rows the rule could have
// produced), in one transaction. A full reclassify afterwards lets older
// rules and built-ins claim what they match.
export function removeRule(db, { side, match }, fileRules) {
  if (side !== 'in' && side !== 'out') throw new Error('כיוון לא תקין');
  const m = String(match || '').trim();
  return db.transaction(() => {
    const r = db.prepare('SELECT counterparty, bucket, bucket_group FROM classify_rules WHERE side=? AND match=?').get(side, m);
    if (!r) throw new Error('החוק לא נמצא');
    db.prepare('DELETE FROM classify_rules WHERE side=? AND match=?').run(side, m);
    const n = db.prepare(`
      UPDATE bank_transactions SET bucket='unclassified', bucket_group='unclassified', updated_at=datetime('now')
      WHERE account_type='CHECKING' AND currency='ILS' AND bucket=? AND bucket_group=?
        AND ((? = 'in' AND amount >= 0) OR (? = 'out' AND amount < 0))
        AND TRIM(COALESCE(counterparty, raw_desc, '')) = ?
    `).run(r.bucket, r.bucket_group, side, side, r.counterparty || '').changes;
    return { removed: { side, match: m, bucket: r.bucket }, reverted: n };
  }).immediate();
}
