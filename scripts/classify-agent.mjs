// The classification agent, headless. Collects the unclassified bank rows,
// asks Claude (through the user's Claude Code subscription, no tools, no API
// key) for a category per counterparty, and saves the proposals for the
// approval panel. Nothing is written to config until a person approves.
// Run: npm run classify   (or --snapshot-only)
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherUnclassified, ruleExamples, parseProposals, BANK_BUCKETS } from './lib/classify-agent.mjs';
import { ensureConsent, ensureSubscription, runClaude, writeJsonAtomic, INJECTION_NOTE } from './lib/agent-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const OUT = join(ROOT, 'data', 'classify');
mkdirSync(OUT, { recursive: true });

const q = await import('../lib/queries.js');
const db = q.getDb();
const today = q.israelToday();
const u = gatherUnclassified(db);
const vocabulary = Object.fromEntries(Object.entries(BANK_BUCKETS).map(([side, v]) => [side, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.label]))]));
const snapshot = { date: today, entityType: q.settings.entityType ?? null, groups: u.groups, totalGroups: u.totalGroups, totalRows: u.totalRows, totalAmount: u.totalAmount, vocabulary, examples: ruleExamples() };
writeFileSync(join(OUT, 'snapshot.json'), JSON.stringify(snapshot, null, 1));
console.log(`snapshot: ${u.totalGroups} מוטבים לא מסווגים (${u.totalRows} תנועות)`);
if (process.argv.includes('--snapshot-only')) process.exit(0);
if (!u.groups.length) {
  writeJsonAtomic(join(OUT, 'proposals.json'), { date: today, ts: new Date().toISOString(), ok: true, proposals: [], note: 'אין תנועות לא מסווגות' });
  console.log('אין מה לסווג'); process.exit(0);
}

if (!ensureConsent()) process.exit(2);
if (!ensureSubscription()) process.exit(2);
const skill = readFileSync(join(ROOT, '.claude', 'skills', 'classify', 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '');
const prompt = `${skill}\n\n${INJECTION_NOTE}\n\n## הנתונים\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n\nהחזר עכשיו רק את בלוק ה-JSON.`;
const res = runClaude(prompt);
if (!res.ok) {
  writeJsonAtomic(join(OUT, 'proposals.json'), { date: today, ts: new Date().toISOString(), ok: false, error: res.error });
  console.error('classify failed:', res.error);
  process.exit(1);
}
const fresh = parseProposals(res.text, u.groups);
if (!fresh.length) {
  writeJsonAtomic(join(OUT, 'proposals.json'), { date: today, ts: new Date().toISOString(), ok: false, error: 'Claude לא החזיר הצעות תקינות (בלוק JSON עם קטגוריות מהמילון)' });
  console.error('classify: no valid proposals in the answer');
  process.exit(1);
}
// Keep earlier decisions (approved / rejected) for counterparties still present.
let prev = [];
try { prev = JSON.parse(readFileSync(join(OUT, 'proposals.json'), 'utf8')).proposals || []; } catch { /* first run */ }
const k = (p) => p.side + '|' + p.counterparty;
const decided = new Map(prev.filter((p) => p.status !== 'pending').map((p) => [k(p), p]));
const proposals = fresh.map((p) => decided.get(k(p)) || p);
writeJsonAtomic(join(OUT, 'proposals.json'), { date: today, ts: new Date().toISOString(), ok: true, proposals, totalGroups: u.totalGroups, totalRows: u.totalRows, totalAmount: u.totalAmount });
console.log(`proposals saved: ${proposals.length} (data/classify/proposals.json)`);
