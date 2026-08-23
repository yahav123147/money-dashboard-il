import { getDb, computeCashflow } from '@/lib/queries';

export const dynamic = 'force-dynamic';

// GET /api/cashflow?days=30|60|90
export async function GET(req) {
  try {
    const days = Number(new URL(req.url).searchParams.get('days')) || 30;
    return Response.json(computeCashflow(getDb(), undefined, days));
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
