// The classification agent, headless. Collects the unclassified bank rows,
// asks Claude (through the user's Claude Code subscription, no tools, no API
// key) for a category per counterparty, and saves the proposals for the
// approval panel. Nothing is written to config until a person approves.
// Run: npm run classify   (or --snapshot-only)
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherUnclassified, ruleExamples, parseProposals, saveProposals, logAgentRun, BANK_BUCKETS } from './lib/classify-agent.mjs';
import { preflight, runClaude, writeJsonAtomic, INJECTION_NOTE } from './lib/agent-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const OUT = join(ROOT, 'data', 'classify');
mkdirSync(OUT, { recursive: true });

if (!preflight()) process.exit(2);

const q = await import('../lib/queries.js');
const db = q.getDb();
const today = q.israelToday();
const u = gatherUnclassified(db);
const vocabulary = Object.fromEntries(Object.entries(BANK_BUCKETS).map(([side, v]) => [side, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.label]))]));
const snapshot = { date: today, entityType: q.settings.entityType ?? null, groups: u.groups, totalGroups: u.totalGroups, totalRows: u.totalRows, totalAmount: u.totalAmount, vocabulary, examples: ruleExamples(db) };
writeFileSync(join(OUT, 'snapshot.json'), JSON.stringify(snapshot, null, 1));
console.log(`snapshot: ${u.totalGroups} מוטבים לא מסווגים (${u.totalRows} תנועות)`);
if (process.argv.includes('--snapshot-only')) process.exit(0);
if (!u.groups.length) {
  saveProposals(db, []);
  logAgentRun(db, 'classify', { ok: true, count: 0, note: 'אין תנועות לא מסווגות' });
  console.log('אין מה לסווג'); process.exit(0);
}

const skill = readFileSync(join(ROOT, '.claude', 'skills', 'classify', 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '');
const prompt = `${skill}\n\n${INJECTION_NOTE}\n\n## הנתונים\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n\nהחזר עכשיו רק את בלוק ה-JSON.`;
const res = runClaude(prompt);
const fail = (error) => { logAgentRun(db, 'classify', { ok: false, error }); console.error('classify failed:', error); process.exit(1); };
if (!res.ok) fail(res.error);
const fresh = parseProposals(res.text, u.groups);
if (fresh === null) fail('Claude לא החזיר בלוק JSON תקין');
// An empty array is a legitimate answer ("nothing I can name"), not a failure.
const n = saveProposals(db, fresh);
logAgentRun(db, 'classify', { ok: true, count: n });
console.log(`proposals saved: ${n} (classify_proposals)`);
