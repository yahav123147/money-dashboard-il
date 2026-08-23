import { getDb } from '@/lib/queries';
import { applyProposal, gatherUnclassified, listRules, removeRule, listProposals, setProposalStatus, lastAgentRun } from '../../../scripts/lib/classify-agent.mjs';
export const dynamic = 'force-dynamic';

// Everything lives in SQLite: proposals, decisions, rules, runs. One
// transaction per action, so the rule, the rows and the status never disagree.
export async function GET() {
  try {
    const db = getDb();
    const u = gatherUnclassified(db, { limit: 0 });
    const proposals = listProposals(db);
    const run = lastAgentRun(db, 'classify');
    return Response.json({ ok: true, empty: !run, ts: run?.ts || null, lastRun: run, proposals, rules: listRules(db), now: { groups: u.totalGroups, rows: u.totalRows, amount: u.totalAmount } });
  } catch (err) { return Response.json({ error: String(err?.message || err) }, { status: 500 }); }
}

// POST { action: 'approve'|'reject', side, counterparty } | { action: 'undo', side, match }
export async function POST(req) {
  let body; try { body = await req.json(); } catch { body = {}; }
  if (body.side !== 'in' && body.side !== 'out') return Response.json({ error: 'חסר כיוון (side)' }, { status: 400 });
  try {
    const db = getDb();
    if (body.action === 'undo') return Response.json({ ok: true, ...removeRule(db, { side: body.side, match: body.match }) });
    const name = String(body.counterparty || '').trim();
    const p = listProposals(db).find((x) => x.side === body.side && x.counterparty === name);
    if (!p) return Response.json({ error: 'הצעה לא נמצאה' }, { status: 404 });
    if (body.action === 'approve') {
      if (!['pending', 'undone'].includes(p.status)) return Response.json({ error: 'ההצעה כבר הוחלטה' }, { status: 409 });
      const res = applyProposal(db, { side: p.side, match: body.match || p.match, bucket: body.bucket || p.bucket, counterparty: p.counterparty });
      return Response.json({ ok: true, proposal: { ...p, status: 'approved', reclassified: res.reclassified } });
    }
    if (body.action === 'reject') { setProposalStatus(db, { side: p.side, counterparty: p.counterparty, status: 'rejected' }); return Response.json({ ok: true }); }
    return Response.json({ error: 'פעולה לא מוכרת' }, { status: 400 });
  } catch (err) { return Response.json({ error: String(err?.message || err) }, { status: 400 }); }
}
