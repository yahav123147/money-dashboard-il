import { getDb, computeBanks } from '@/lib/queries';
export const dynamic = 'force-dynamic';
export async function GET(req) {
  try {
    const days = Number(new URL(req.url).searchParams.get('days')) || 30;
    return Response.json(computeBanks(getDb(), undefined, days));
  } catch (err) { return Response.json({ error: String(err?.message || err) }, { status: 500 }); }
}
