import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, israelToday } from '@/lib/queries';
import { cleanupAskShadows, dataPack, runReadOnlyAsync, parseReply, SCHEMA_DOC } from '../../../scripts/lib/ask.mjs';
import { INJECTION_NOTE } from '../../../scripts/lib/agent-run.mjs';
import { guardLocalJsonRequest, runGatedClaudeAsync } from '../../../scripts/lib/ask-run.mjs';

// One question at a time per server: each is a model call, and two in
// flight would only queue behind each other at the CLI anyway.
let inFlight = false;
export const dynamic = 'force-dynamic';

const DB_PATH = process.env.MONEY_DB_PATH || join(process.cwd(), 'data', 'money.db');

// POST { question, history: [{ role: 'user'|'assistant', text }] }
// One model call with the data pack; if the model asks for a query, one
// read-only SELECT and one more call. Same gate as every other agent.
export async function POST(req) {
  const requestGate = guardLocalJsonRequest(req);
  if (!requestGate.ok) return Response.json({ error: requestGate.error }, { status: requestGate.status });
  let body; try { body = await req.json(); } catch { body = {}; }
  const question = String(body.question || '').trim().slice(0, 1000);
  if (!question) return Response.json({ error: 'מה השאלה?' }, { status: 400 });
  const history = Array.isArray(body.history) ? body.history.slice(-6).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', text: String(h.text || '').slice(0, 1500) })) : [];

  if (inFlight) return Response.json({ error: 'שאלה אחרת עדיין בטיפול; עוד רגע' }, { status: 429 });
  inFlight = true;
  try { return await answer(question, history); } finally { inFlight = false; }
}

async function answer(question, history) {
  try {
    // Also retire old/stale shadows when the model can answer from dataPack
    // and never asks for SQL.
    cleanupAskShadows(DB_PATH);
    const db = getDb();
    const today = israelToday();
    const pack = dataPack(db, today);
    // The prompt is deliberately not a Claude Code skill. Questions must go
    // through this API so consent, subscription and provider checks cannot be
    // bypassed by invoking an interactive /ask command.
    const skill = readFileSync(join(process.cwd(), 'scripts', 'prompts', 'ask.md'), 'utf8');
    const convo = history.map((h) => `${h.role === 'user' ? 'בעל העסק' : 'אתה'}: ${h.text}`).join('\n');
    const base = `${skill}\n\n${INJECTION_NOTE}\n\n## הסכמה\n${SCHEMA_DOC}\n\n## dataPack\n\`\`\`json\n${JSON.stringify(pack)}\n\`\`\`\n${convo ? `\n## השיחה עד כה\n${convo}\n` : ''}\n## השאלה\n${question}`;
    const first = await runGatedClaudeAsync(base);
    if (!first.ok) return Response.json({ error: first.error }, { status: first.inputRejected ? 413 : first.gateDenied ? 403 : 502 });
    let reply = parseReply(first.text);
    let sql = null; let rows = null;
    if (reply.sql) {
      sql = reply.sql;
      let result;
      try { result = await runReadOnlyAsync(DB_PATH, sql); rows = result.rows; }
      catch (e) { result = { error: String(e.message || e) }; }
      const second = await runGatedClaudeAsync(`${base}\n\n## השאילתה שביקשת\n\`\`\`sql\n${sql}\n\`\`\`\n## התוצאה\n\`\`\`json\n${JSON.stringify(result).slice(0, 60000)}\n\`\`\`\n\nעכשיו ענה לשאלה. בלי בלוק SQL נוסף.`);
      if (!second.ok) return Response.json({ error: second.error }, { status: second.inputRejected ? 413 : second.gateDenied ? 403 : 502 });
      reply = parseReply(second.text);
      if (reply.sql) reply = { answer: 'לא הצלחתי לענות מהנתונים שיש לי על השאלה הזאת.' };
    }
    return Response.json({ ok: true, answer: reply.answer, sql, rows: rows ? rows.slice(0, 50) : null, asOf: pack.lastBankSync });
  } catch (err) { return Response.json({ error: String(err?.message || err) }, { status: 500 }); }
}
