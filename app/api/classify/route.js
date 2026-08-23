import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '@/lib/queries';
import { applyProposal, gatherUnclassified } from '../../../scripts/lib/classify-agent.mjs';
export const dynamic = 'force-dynamic';

const DIR = join(process.cwd(), 'data', 'classify');
const FILE = join(DIR, 'proposals.json');
const load = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null);

// GET: the saved proposals + how much is still unclassified right now.
export async function GET() {
  try {
    const db = getDb();
    const u = gatherUnclassified(db, { limit: 0 });
    const saved = load();
    return Response.json({ ...(saved || { ok: false, empty: true, proposals: [] }), now: { groups: u.totalGroups, rows: u.totalRows, amount: u.totalAmount } });
  } catch (err) { return Response.json({ error: String(err?.message || err) }, { status: 500 }); }
}

// POST { action: 'approve', counterparty, bucket?, match? } writes the rule and reclassifies.
// POST { action: 'reject', counterparty } marks it; nothing is written to config.
export async function POST(req) {
  let body; try { body = await req.json(); } catch { body = {}; }
  const saved = load();
  if (!saved || !Array.isArray(saved.proposals)) return Response.json({ error: 'אין הצעות; הרץ npm run classify' }, { status: 400 });
  const p = saved.proposals.find((x) => x.counterparty === body.counterparty);
  if (!p) return Response.json({ error: 'הצעה לא נמצאה' }, { status: 404 });
  try {
    if (body.action === 'approve') {
      const bucket = body.bucket || p.bucket;
      const match = body.match || p.match;
      const res = applyProposal(getDb(), { side: p.side, match, bucket });
      Object.assign(p, { status: 'approved', bucket, match, appliedAt: new Date().toISOString(), reclassified: res.reclassified });
    } else if (body.action === 'reject') {
      p.status = 'rejected';
    } else return Response.json({ error: 'פעולה לא מוכרת' }, { status: 400 });
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(saved, null, 1));
    return Response.json({ ok: true, proposal: p });
  } catch (err) { return Response.json({ error: String(err?.message || err) }, { status: 400 }); }
}
