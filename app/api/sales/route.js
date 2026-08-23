import { getDb, computeSalesRange, israelToday } from '@/lib/queries';

export const dynamic = 'force-dynamic';

// GET /api/sales?from=YYYY-MM-DD&to=YYYY-MM-DD  (Israel calendar days, inclusive)
export async function GET(req) {
  try {
    const url = new URL(req.url);
    const from = url.searchParams.get('from') || israelToday();
    const to = url.searchParams.get('to') || from;
    return Response.json(computeSalesRange(getDb(), from, to));
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 400 });
  }
}
