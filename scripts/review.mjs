// The financial agent, headless. Builds a snapshot of what the dashboard
// shows, hands it to Claude through the user's own Claude Code subscription
// (`claude -p`, no API key, no tools), and saves the review for the
// "אמינות הנתונים" panel. Run: npm run review   (or --snapshot-only)
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const OUT = join(ROOT, 'data', 'review');
mkdirSync(OUT, { recursive: true });

const q = await import('../lib/queries.js');
const db = q.getDb();
const today = q.israelToday();
const safe = (fn) => { try { return fn(); } catch (e) { return { error: String(e?.message || e) }; } };

// Only what the reviewer needs; recurring/cashflow items carry counterparty
// names from the user's own bank, which is the point of the review.
const s = q.settings;
const snapshot = {
  date: today,
  settings: { entityType: s.entityType, vatPeriodMonths: s.vatPeriodMonths, vatDueDay: s.vatDueDay, advanceDueDay: s.advanceDueDay, advanceRatePct: s.advanceRatePct, usdToIls: s.usdToIls, cashDipWarnIls: s.cashDipWarnIls },
  briefing: safe(() => q.computeBriefing(db)),
  quality: safe(() => q.computeQuality(db, today)),
  cashflow: safe(() => { const c = q.computeCashflow(db, today, 30); return { startBalance: c.startBalance, dip: c.dip, endProjected: c.endProjected, days: c.days.filter((d) => d.items.length).map((d) => ({ date: d.date, projected: d.projected, items: d.items })) }; }),
  recurring: safe(() => q.computeRecurring(db, today)),
  vat: safe(() => q.computeVat(db)),
  advancesYtd: safe(() => q.computeAdvancesYtd(db)),
  reconcile: safe(() => { const r = q.computeReconcile(db, 120); return { enabled: r.enabled, mode: r.mode, summary: r.summary, byAcquirer: r.byAcquirer, rows: (r.rows || []).map(({ credits, ...x }) => x) }; }),
};
writeFileSync(join(OUT, 'snapshot.json'), JSON.stringify(snapshot, null, 1));
console.log(`snapshot: data/review/snapshot.json (${today})`);
if (process.argv.includes('--snapshot-only')) process.exit(0);

const skill = readFileSync(join(ROOT, '.claude', 'skills', 'review', 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '');
const prompt = `${skill}\n\n## הנתונים\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n\nכתוב את הסקירה עכשיו, בפורמט ארבע הכותרות בלבד.`;

// Subscription only: strip any API key so claude -p cannot bill an API account.
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
const args = ['-p', '--tools', '', '--no-session-persistence', '--output-format', 'text'];
if (process.env.REVIEW_MODEL) args.push('--model', process.env.REVIEW_MODEL);
const res = spawnSync('claude', args, { input: prompt, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
if (res.error || res.status !== 0) {
  const msg = res.error ? String(res.error.message) : (res.stderr || res.stdout || '').trim().slice(0, 500);
  writeFileSync(join(OUT, 'latest.json'), JSON.stringify({ date: today, ts: new Date().toISOString(), ok: false, error: msg || `claude exited ${res.status}` }));
  console.error('review failed:', msg || res.status);
  process.exit(1);
}
const text = res.stdout.trim().replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, ', ');
writeFileSync(join(OUT, 'latest.md'), text);
writeFileSync(join(OUT, 'latest.json'), JSON.stringify({ date: today, ts: new Date().toISOString(), ok: true, text }));
console.log(`review saved: data/review/latest.md (${text.length} chars)`);
