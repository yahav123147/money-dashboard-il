import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, computeRecurring } from '@/lib/queries';

export const dynamic = 'force-dynamic';
const PATH = join(process.cwd(), 'config', 'recurring.json');

export async function GET() {
  try { return Response.json(computeRecurring(getDb())); }
  catch (err) { return Response.json({ error: String(err?.message || err) }, { status: 500 }); }
}

// POST { action: 'ignore' | 'confirm' | 'unignore', item: { name, day, amount, bucket } }
// confirm: copy a learned item into recurring.json items (it stops being "learned").
// ignore: add the name to recurring.json ignore.
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const name = String(body?.item?.name || '').trim();
  if (!name) return Response.json({ error: 'חסר שם' }, { status: 400 });
  const cfg = JSON.parse(readFileSync(PATH, 'utf8'));
  cfg.items = Array.isArray(cfg.items) ? cfg.items : [];
  cfg.ignore = Array.isArray(cfg.ignore) ? cfg.ignore : [];
  if (body.action === 'ignore') {
    if (!cfg.ignore.includes(name)) cfg.ignore.push(name);
    cfg.items = cfg.items.filter((it) => it.name !== name);
  } else if (body.action === 'unignore') {
    cfg.ignore = cfg.ignore.filter((n) => n !== name);
  } else if (body.action === 'confirm') {
    const it = body.item;
    const day = Number(it.day); const amount = Number(it.amount);
    if (!(day >= 1 && day <= 31) || !Number.isFinite(amount)) return Response.json({ error: 'יום או סכום לא תקינים' }, { status: 400 });
    cfg.items = cfg.items.filter((x) => x.name !== name);
    cfg.items.push({ name, day, amount: Math.round(amount), bucket: it.bucket || null });
    cfg.ignore = cfg.ignore.filter((n) => n !== name);
  } else {
    return Response.json({ error: 'action לא מוכר' }, { status: 400 });
  }
  writeFileSync(PATH, JSON.stringify(cfg, null, 2) + '\n');
  return Response.json({ ok: true, items: cfg.items.length, ignore: cfg.ignore.length });
}
