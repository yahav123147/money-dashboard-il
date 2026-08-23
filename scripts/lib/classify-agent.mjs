// The classification agent's plumbing: what to show it, how to read what it
// proposes, and how an approved proposal becomes a permanent rule. The agent
// itself (Claude, through the user's subscription) only ever sees the
// groups below and returns JSON; every write goes through applyProposal,
// after a person approved it in the dashboard or in /classify.
import { loadRules, explicitRules, withExplicit, classifyAllLocked } from './classify.mjs';
import { existsSync, readFileSync, renameSync } from 'node:fs';


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

// What a substring rule would touch besides the counterparty it was proposed
// for. Shown before approval, so "הוט" → rent is a conscious choice.
export function alsoMatches(db, side, match, counterparty, limit = 6) {
  const m = String(match || '').trim();
  if (m.length < 2) return { total: 0, rows: 0, names: [] };
  const all = db.prepare(`
    SELECT TRIM(COALESCE(counterparty, raw_desc, '')) name, COUNT(*) n FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS'
      AND ((? = 'in' AND amount >= 0) OR (? = 'out' AND amount < 0))
      AND instr(COALESCE(counterparty,'') || ' ' || COALESCE(raw_desc,''), ?) > 0
      AND TRIM(COALESCE(counterparty, raw_desc, '')) != ?
    GROUP BY name ORDER BY n DESC
  `).all(side, side, m, String(counterparty || '').trim());
  return { total: all.length, rows: all.reduce((a, x) => a + x.n, 0), names: all.slice(0, limit) };
}

// Count rows whose classification (bucket, group or sub-bucket) differs between two snapshots.
function snapshot(db) { return new Map(db.prepare('SELECT id, bucket, bucket_group, sub_bucket FROM bank_transactions').all().map((x) => [x.id, `${x.bucket}|${x.bucket_group}|${x.sub_bucket || ''}`])); }
function reclassifyCounting(db, fileRules) {
  const before = snapshot(db);
  classifyAllLocked(db, withExplicit(db, fileRules));
  let changed = 0;
  for (const [id, v] of snapshot(db)) if (before.get(id) !== v) changed += 1;
  return changed;
}

// A rule change, the rows and the proposal status are one unit. The rule is
// a substring rule and applies everywhere a sync would apply it (the same
// history a sync rewrites), so approval = what the next sync would do.
// `reclassified` counts every row whose classification changed.
export function applyProposal(db, { side, match, bucket, counterparty }, fileRules = loadRules()) {
  if (side !== 'in' && side !== 'out') throw new Error('כיוון לא תקין');
  const vocab = BANK_BUCKETS[side];
  if (typeof bucket !== 'string' || !Object.hasOwn(vocab, bucket)) throw new Error('קטגוריה לא מוכרת');
  const { group } = vocab[bucket];
  const name = String(counterparty || '').trim();
  if (!name) throw new Error('חסר שם מוטב');
  const m = String(match || '').trim();
  if (m.length < 2) throw new Error('טקסט התאמה קצר מדי');
  if (!name.includes(m)) throw new Error('טקסט ההתאמה חייב להופיע בשם המוטב');
  return db.transaction(() => {
    const priority = db.prepare('SELECT COALESCE(MAX(priority), 0) + 1 p FROM classify_rules').get().p;
    db.prepare(`
      INSERT INTO classify_rules (side, match, bucket, bucket_group, counterparty, created_at, priority)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(side, match) DO UPDATE SET bucket=excluded.bucket, bucket_group=excluded.bucket_group, counterparty=excluded.counterparty, created_at=excluded.created_at, priority=excluded.priority
    `).run(side, m, bucket, group, name, priority);
    const changed = reclassifyCounting(db, fileRules);
    // The proposal moves pending/undone → approved atomically; a concurrent
    // reject or a second approve sees "already decided" instead of racing.
    const moved = db.prepare(`UPDATE classify_proposals SET status='approved', decided_at=datetime('now'), reclassified=?, bucket=?, bucket_group=?, match=? WHERE side=? AND counterparty=? AND status IN ('pending','undone')`).run(changed, bucket, group, m, side, name).changes;
    if (!moved && db.prepare(`SELECT 1 FROM classify_proposals WHERE side=? AND counterparty=?`).get(side, name)) throw new Error('ההצעה כבר הוחלטה');
    // One rule per (side, match): every other approved proposal that rides
    // the same rule now reflects the category that is actually in force.
    db.prepare(`UPDATE classify_proposals SET bucket=?, bucket_group=? WHERE side=? AND match=? AND status='approved' AND counterparty != ?`).run(bucket, group, side, m, name);
    return { rule: { match: [m], bucket, group }, reclassified: changed };
  }).immediate();
}

// The explicit rules, newest decision first, for the panel.
export function listRules(db) {
  return db.prepare('SELECT side, match, bucket, bucket_group AS "group", counterparty, created_at AS createdAt, priority FROM classify_rules ORDER BY priority DESC, created_at DESC').all();
}

// Undo a rule: delete it, re-run the classification, and reopen the proposal
// it came from, all in one transaction. Rows the rule had claimed fall back
// to older rules and built-ins (a small amount may land in the default
// supplier bucket rather than "unclassified": that is the built-in's call).
export function removeRule(db, { side, match }, fileRules = loadRules()) {
  if (side !== 'in' && side !== 'out') throw new Error('כיוון לא תקין');
  const m = String(match || '').trim();
  return db.transaction(() => {
    const r = db.prepare('SELECT counterparty, bucket FROM classify_rules WHERE side=? AND match=?').get(side, m);
    if (!r) throw new Error('החוק לא נמצא');
    db.prepare('DELETE FROM classify_rules WHERE side=? AND match=?').run(side, m);
    const changed = reclassifyCounting(db, fileRules);
    // The proposal stays visible as "undone" (not deleted by the next agent
    // run, even if a built-in default now claims the rows), so the owner can
    // pick another category.
    const reopened = db.prepare(`UPDATE classify_proposals SET status='undone', decided_at=datetime('now'), reclassified=NULL WHERE side=? AND match=? AND status='approved'`).run(side, m).changes;
    return { removed: { side, match: m, bucket: r.bucket, counterparty: r.counterparty }, reverted: changed, reopened };
  }).immediate();
}

// Proposals: the agent's fresh list is merged over the table, keeping
// decisions already made (approved / rejected) for names still present.
export function saveProposals(db, fresh, run = null) {
  const up = db.prepare(`
    INSERT INTO classify_proposals (side, counterparty, match, bucket, bucket_group, label, reason, confidence, count, total, status, proposed_at)
    VALUES (@side, @counterparty, @match, @bucket, @group, @label, @reason, @confidence, @count, @total, 'pending', datetime('now'))
    ON CONFLICT(side, counterparty) DO UPDATE SET
      match = CASE WHEN classify_proposals.status = 'pending' THEN excluded.match ELSE classify_proposals.match END,
      bucket = CASE WHEN classify_proposals.status = 'pending' THEN excluded.bucket ELSE classify_proposals.bucket END,
      bucket_group = CASE WHEN classify_proposals.status = 'pending' THEN excluded.bucket_group ELSE classify_proposals.bucket_group END,
      label = excluded.label, reason = excluded.reason, confidence = excluded.confidence,
      count = excluded.count, total = excluded.total, proposed_at = excluded.proposed_at
  `);
  return db.transaction(() => {
    const keep = new Set(fresh.map((p) => p.side + '|' + p.counterparty));
    // names no longer unclassified (classified by a sync, or gone) leave the pending list
    for (const row of db.prepare(`SELECT side, counterparty FROM classify_proposals WHERE status='pending'`).all()) {
      if (!keep.has(row.side + '|' + row.counterparty)) db.prepare(`DELETE FROM classify_proposals WHERE side=? AND counterparty=?`).run(row.side, row.counterparty);
    }
    for (const p of fresh) up.run(p);
    if (run) db.prepare(`INSERT INTO agent_runs (agent, ts, ok, error, count, note) VALUES ('classify', datetime('now'), 1, NULL, ?, ?)`).run(fresh.length, run.note || null);
    return fresh.length;
  }).immediate();
}

// One-time import of decisions made before proposals moved into SQLite.
export function importLegacyProposals(db, file) {
  if (!existsSync(file)) return 0;
  let j; try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { return 0; }
  const items = Array.isArray(j?.proposals) ? j.proposals.filter((p) => p.status === 'approved' || p.status === 'rejected') : [];
  const ins = db.prepare(`INSERT OR IGNORE INTO classify_proposals (side, counterparty, match, bucket, bucket_group, label, reason, confidence, count, total, status, proposed_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const n = db.transaction(() => { let k = 0; for (const p of items) k += ins.run(p.side, p.counterparty, p.match, p.bucket, p.group, p.label, p.reason, p.confidence, p.count, p.total, p.status, j.ts || null, p.appliedAt || j.ts || null).changes; return k; }).immediate();
  renameSync(file, file + '.imported');
  return n;
}
export function listProposals(db) {
  return db.prepare(`SELECT side, counterparty, match, bucket, bucket_group AS "group", label, reason, confidence, count, total, status, proposed_at AS proposedAt, decided_at AS decidedAt, reclassified FROM classify_proposals ORDER BY ABS(total) DESC`).all()
    .map((p) => ({ ...p, alsoMatches: (p.status === 'pending' || p.status === 'undone') ? alsoMatches(db, p.side, p.match, p.counterparty) : { total: 0, rows: 0, names: [] },
      currentBucket: p.status === 'undone' ? (db.prepare(`SELECT bucket FROM bank_transactions WHERE TRIM(COALESCE(counterparty, raw_desc,''))=? AND ((?='in' AND amount>=0) OR (?='out' AND amount<0)) ORDER BY date DESC LIMIT 1`).get(p.counterparty, p.side, p.side)?.bucket || null) : null }));
}
export function setProposalStatus(db, { side, counterparty, status }) {
  if (!['pending', 'rejected'].includes(status)) throw new Error('סטטוס לא תקין');
  // Only an open proposal can be rejected (or reopened); an approved one has a rule to undo first.
  const n = db.prepare(`UPDATE classify_proposals SET status=?, decided_at=CASE WHEN ?='pending' THEN NULL ELSE datetime('now') END WHERE side=? AND counterparty=? AND status IN ('pending','undone','rejected')`).run(status, status, side, counterparty).changes;
  if (!n) {
    if (db.prepare(`SELECT 1 FROM classify_proposals WHERE side=? AND counterparty=?`).get(side, counterparty)) throw new Error('ההצעה כבר אושרה; לבטל את החוק קודם');
    throw new Error('הצעה לא נמצאה');
  }
  return n;
}
export function logAgentRun(db, agent, { ok, error = null, count = null, note = null }) {
  db.prepare(`INSERT INTO agent_runs (agent, ts, ok, error, count, note) VALUES (?, datetime('now'), ?, ?, ?, ?)`).run(agent, ok ? 1 : 0, error, count, note);
}
export function lastAgentRun(db, agent) {
  const r = db.prepare(`SELECT ts, ok, error, count, note FROM agent_runs WHERE agent=? ORDER BY id DESC LIMIT 1`).get(agent);
  return r ? { ...r, ok: !!r.ok, ts: r.ts.replace(' ', 'T') + 'Z' } : null;
}
