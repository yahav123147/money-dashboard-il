import { getDb, computeBriefing } from '@/lib/queries';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { return Response.json(computeBriefing(getDb())); }
  catch (err) { return Response.json({ error: String(err?.message || err) }, { status: 500 }); }
}
