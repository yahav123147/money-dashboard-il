import { getDb, computeReconcile } from '@/lib/queries';

export const dynamic = 'force-dynamic';

// GET /api/reconcile?days=45
export async function GET(req) {
  try {
    const days = Math.min(180, Math.max(7, Number(new URL(req.url).searchParams.get('days')) || 45));
    return Response.json(computeReconcile(getDb(), days));
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
