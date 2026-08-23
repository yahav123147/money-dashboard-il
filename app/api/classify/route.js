import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '@/lib/queries';
import { applyProposal, gatherUnclassified, listRules, removeRule } from '../../../scripts/lib/classify-agent.mjs';
export const dynamic = 'force-dynamic';

const DIR = join(process.cwd(), 'data', 'classify');
const FILE = join(DIR, 'proposals.json');
const RUN = join(DIR, 'last-run.json');
const load = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null);
const lastRun = () => (existsSync(RUN) ? JSON.parse(readFileSync(RUN, 'utf8')) : null);

// GET: the saved proposals + how much is still unclassified right now.
export async function GET() {
  try {
    const db = getDb();
    const u = gatherUnclassified(db, { limit: 0 });
    const saved = load();
    return Response.json({ ...(saved || { ok: false, empty: true, proposals: [] }), lastRun: lastRun(), rules: listRules(db), now: { groups: u.totalGroups, rows: u.totalRows, amount: u.totalAmount } });
  } catch (err) { return Response.json({ error: String(err?.message || err) }, { status: 500 }); }
}

// POST { action: 'approve', counterparty, bucket?, match? } writes the rule and reclassifies.
// POST { action: 'reject', counterparty } marks it; nothing is written to config.
// POST { action: 'undo', side, match } deletes a rule and puts its rows back to unclassified.
export async function POST(req) {
  let body; try { body = await req.json(); } catch { body = {}; }
  if (body.action === 'undo') {
    try {
      const res = removeRule(getDb(), { side: body.side, match: body.match });
      // The proposal behind this rule is open again: shown now, and re-proposed by the next run.
      const saved0 = load();
      if (saved0 && Array.isArray(saved0.proposals)) {
        for (const p of saved0.proposals) if (p.side === res.removed.side && p.counterparty === res.removed.counterparty && p.status === 'approved') { p.status = 'pending'; delete p.appliedAt; delete p.reclassified; }
        mkdirSync(DIR, { recursive: true });
        const tmp = `${FILE}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        writeFileSync(tmp, JSON.stringify(saved0, null, 1)); renameSync(tmp, FILE);
      }
      return Response.json({ ok: true, ...res });
    } catch (err) { return Response.json({ error: String(err?.message || err) }, { status: 400 }); }
  }
  const saved = load();
  if (!saved || !Array.isArray(saved.proposals)) return Response.json({ error: 'אין הצעות; הרץ npm run classify' }, { status: 400 });
  if (body.side !== 'in' && body.side !== 'out') return Response.json({ error: 'חסר כיוון (side)' }, { status: 400 });
  const p = saved.proposals.find((x) => x.counterparty === body.counterparty && x.side === body.side);
  if (!p) return Response.json({ error: 'הצעה לא נמצאה' }, { status: 404 });
  try {
    if (body.action === 'approve') {
      const bucket = body.bucket || p.bucket;
      const match = body.match || p.match;
      const res = applyProposal(getDb(), { side: p.side, match, bucket, counterparty: p.counterparty });
      Object.assign(p, { status: 'approved', bucket, match, appliedAt: new Date().toISOString(), reclassified: res.reclassified });
    } else if (body.action === 'reject') {
      p.status = 'rejected';
    } else return Response.json({ error: 'פעולה לא מוכרת' }, { status: 400 });
    try {
      mkdirSync(DIR, { recursive: true });
      const tmp = `${FILE}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      writeFileSync(tmp, JSON.stringify(saved, null, 1));
      renameSync(tmp, FILE);
    } catch (err) {
      // The approval itself (rows + rule) is already in effect.
      return Response.json({ ok: true, proposal: p, warning: `האישור בוצע, אבל סטטוס ההצעה לא נשמר: ${String(err?.message || err)}` });
    }
    return Response.json({ ok: true, proposal: p });
  } catch (err) { return Response.json({ error: String(err?.message || err) }, { status: 400 }); }
}
