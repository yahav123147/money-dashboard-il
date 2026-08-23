import { getDb, computeChannels } from '@/lib/queries';
import { addChannelRule, setChannels } from '../../../scripts/lib/channels.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { return Response.json(computeChannels(getDb())); }
  catch (err) { return Response.json({ error: String(err?.message || err) }, { status: 500 }); }
}

// POST { action: 'assign', kind: 'product'|'bank'|'amount', match, amount, channel }
// POST { action: 'setChannels', channels: [...] }
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { body = {}; }
  try {
    if (body.action === 'setChannels') {
      if (!Array.isArray(body.channels)) throw new Error('channels חייב להיות רשימה');
      return Response.json({ ok: true, channels: setChannels(body.channels).channels });
    }
    if (body.action === 'assign') {
      const channel = String(body.channel || '').trim();
      if (!channel) throw new Error('בחר ערוץ');
      addChannelRule({ kind: body.kind, match: body.match, amount: body.amount, channel });
      return Response.json({ ok: true });
    }
    throw new Error('action לא מוכר');
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 400 });
  }
}
