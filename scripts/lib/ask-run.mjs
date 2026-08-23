import { preflightAsync, runClaudeAsync } from './agent-run.mjs';

export const MAX_ASK_PROMPT_BYTES = 1024 * 1024;

function loopbackHostname(hostname) {
  const name = String(hostname || '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1';
}

// The dashboard is a local app, not a public API. A hostile web page must not
// be able to make the browser disclose financial data through localhost, and
// a rebinding hostname must not be accepted merely because it resolves there.
export function guardLocalJsonRequest(request) {
  const contentType = request?.headers?.get?.('content-type') || '';
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    return { ok: false, status: 415, error: 'נדרש Content-Type: application/json' };
  }
  let requestUrl;
  try { requestUrl = new URL(request.url); }
  catch { return { ok: false, status: 400, error: 'כתובת בקשה לא תקינה' }; }
  const host = (request.headers.get('host') || requestUrl.host || '').trim();
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
    if (hostUrl.host.toLowerCase() !== host.toLowerCase() || hostUrl.pathname !== '/') throw new Error('bad host');
  } catch { return { ok: false, status: 403, error: 'ה-API זמין רק מ-localhost' }; }
  if (!loopbackHostname(hostUrl.hostname)) return { ok: false, status: 403, error: 'ה-API זמין רק מ-localhost' };

  const origin = request.headers.get('origin');
  if (origin) {
    let originUrl;
    try { originUrl = new URL(origin); }
    catch { return { ok: false, status: 403, error: 'Origin לא מורשה' }; }
    if (!loopbackHostname(originUrl.hostname) || originUrl.host.toLowerCase() !== host.toLowerCase() || originUrl.protocol !== requestUrl.protocol) {
      return { ok: false, status: 403, error: 'Origin לא מורשה' };
    }
  }
  return { ok: true };
}

// Keep the authorization check adjacent to every model process. In
// particular, a query result is checked again before it can leave the machine.
export async function runGatedClaudeAsync(prompt, { preflight = preflightAsync, run = runClaudeAsync } = {}) {
  const bytes = Buffer.byteLength(String(prompt || ''), 'utf8');
  if (bytes > MAX_ASK_PROMPT_BYTES) {
    return { ok: false, gateDenied: false, inputRejected: true, error: `השאלה וחבילת הנתונים גדולות מדי (${bytes} בתים; המקסימום ${MAX_ASK_PROMPT_BYTES})` };
  }
  let gate;
  try { gate = await preflight(); }
  catch (error) { return { ok: false, gateDenied: true, error: `בדיקת ההרשאה נכשלה: ${error.message || error}` }; }
  if (!gate?.ok) return { ok: false, gateDenied: true, error: gate?.error || 'הסוכן לא זמין' };
  return run(prompt, { claude: gate.claude, claudeEnv: gate.claudeEnv });
}
