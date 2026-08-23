import { getDb, computeAdvances } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const month = new URL(req.url).searchParams.get('month');
    // reject anything that is not a real YYYY-MM rather than passing it into SQL.
    // MM must be 01-12 — \d{2} alone let 2026-13/2026-00 through, which then
    // threw 'Invalid time value' out of shiftDate's date arithmetic (a 500)
    // instead of falling back cleanly the way non-numeric junk does.
    const safe = /^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') ? month : undefined;
    return Response.json(computeAdvances(getDb(), safe));
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
