import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '@/lib/queries';
export const dynamic = 'force-dynamic';
// The last saved review from scripts/review.mjs, or an empty state.
export async function GET() {
  const p = join(process.cwd(), 'data', 'review', 'latest.json');
  if (!existsSync(p)) return Response.json({ ok: false, empty: true });
  try {
    const r = JSON.parse(readFileSync(p, 'utf8'));
    // A review written before the latest successful sync describes old numbers.
    const lastSync = getDb().prepare(`SELECT MAX(ts) ts FROM sync_log WHERE ok=1`).get().ts;
    r.stale = !!(r.ok && lastSync && (!r.syncTs || r.syncTs < lastSync));
    return Response.json(r);
  }
  catch (err) { return Response.json({ ok: false, error: String(err?.message || err) }, { status: 500 }); }
}
