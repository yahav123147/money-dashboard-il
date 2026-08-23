import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export const dynamic = 'force-dynamic';
// The last saved review from scripts/review.mjs, or an empty state.
export async function GET() {
  const p = join(process.cwd(), 'data', 'review', 'latest.json');
  if (!existsSync(p)) return Response.json({ ok: false, empty: true });
  try { return Response.json(JSON.parse(readFileSync(p, 'utf8'))); }
  catch (err) { return Response.json({ ok: false, error: String(err?.message || err) }, { status: 500 }); }
}
