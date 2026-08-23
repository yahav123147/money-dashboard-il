// The financial agent, headless. Builds a snapshot of what the dashboard
// shows, hands it to Claude through the owner's Claude Code subscription
// (`claude -p`, no tools, no API key), validates the answer and saves it
// for the "הסוכן הפיננסי" panel. Run: npm run review   (or --snapshot-only)
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureConsent, ensureSubscription, runClaude, writeJsonAtomic, hasHeadings, INJECTION_NOTE } from './lib/agent-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const OUT = join(ROOT, 'data', 'review');
mkdirSync(OUT, { recursive: true });

// Consent and subscription come first, also for --snapshot-only: the
// snapshot is the financial data, whoever reads it next.
if (!ensureConsent()) process.exit(2);
if (!ensureSubscription()) process.exit(2);

const q = await import('../lib/queries.js');
const db = q.getDb();
const today = q.israelToday();
// Captured BEFORE the snapshot: a sync finishing while Claude runs must leave
// this review marked as older than that sync.
const lastSync = db.prepare(`SELECT MAX(ts) ts FROM sync_log WHERE ok=1`).get().ts;
const safe = (fn) => { try { return fn(); } catch (e) { return { error: String(e?.message || e) }; } };

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
const prompt = `${skill}\n\n${INJECTION_NOTE}\n\n## הנתונים\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n\nכתוב את הסקירה עכשיו, בפורמט ארבע הכותרות בלבד.`;
const res = runClaude(prompt);
const HEADINGS = ['### השורה התחתונה', '### מה נראה לא נכון', '### מה לתקן', '### שאלות לבעל העסק'];
if (res.ok && !hasHeadings(res.text, HEADINGS)) { res.ok = false; res.error = 'הסקירה חזרה בלי ארבע הכותרות, כל אחת בשורה משלה ובסדר הנכון'; }
if (!res.ok) {
  writeJsonAtomic(join(OUT, 'latest.json'), { date: today, ts: new Date().toISOString(), ok: false, error: res.error, syncTs: lastSync });
  console.error('review failed:', res.error);
  process.exit(1);
}
writeFileSync(join(OUT, 'latest.md'), res.text);
writeJsonAtomic(join(OUT, 'latest.json'), { date: today, ts: new Date().toISOString(), ok: true, text: res.text, syncTs: lastSync });
console.log(`review saved: data/review/latest.md (${res.text.length} chars)`);
