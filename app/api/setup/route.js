import { execFile } from 'node:child_process';
import { applySetup, setupStatus } from '../../../scripts/lib/setup.mjs';

export const dynamic = 'force-dynamic';
const ROOT = process.cwd();

export async function GET() {
  try {
    return Response.json(setupStatus({ root: ROOT }));
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}

function run(script, args = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd: ROOT, timeout: 240_000, maxBuffer: 4e6 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() }));
  });
}

// POST body: answers from the wizard. Saves, then runs the first sync so the
// dashboard opens with data. Secrets are never echoed back.
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { body = {}; }
  let saved;
  try {
    saved = applySetup(body, { root: ROOT });
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 400 });
  }
  const sync = {};
  if (body.runSync !== false) {
    const status = setupStatus({ root: ROOT });
    if (status.hasFinancy) sync.financy = await run('scripts/financy-sync.mjs');
    if (status.cardcomEnabled && status.hasCardcom) sync.cardcom = await run('scripts/cardcom-sync.mjs');
  }
  return Response.json({ ok: true, ...saved, sync });
}
