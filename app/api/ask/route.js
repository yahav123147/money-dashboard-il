import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, israelToday } from '@/lib/queries';
import { dataPack, runReadOnly, parseReply, SCHEMA_DOC } from '../../../scripts/lib/ask.mjs';
import { preflight, runClaude, INJECTION_NOTE } from '../../../scripts/lib/agent-run.mjs';
export const dynamic = 'force-dynamic';

const DB_PATH = process.env.MONEY_DB_PATH || join(process.cwd(), 'data', 'money.db');

// POST { question, history: [{ role: 'user'|'assistant', text }] }
// One model call with the data pack; if the model asks for a query, one
// read-only SELECT and one more call. Same gate as every other agent.
export async function POST(req) {
  let body; try { body = await req.json(); } catch { body = {}; }
  const question = String(body.question || '').trim().slice(0, 1000);
  if (!question) return Response.json({ error: 'מה השאלה?' }, { status: 400 });
  const history = Array.isArray(body.history) ? body.history.slice(-6).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', text: String(h.text || '').slice(0, 1500) })) : [];

  const errs = [];
  const origErr = console.error; console.error = (...a) => errs.push(a.join(' '));
  let ok; try { ok = preflight([]); } finally { console.error = origErr; }
  if (!ok) return Response.json({ error: errs.join('\n') || 'הסוכן לא זמין' }, { status: 403 });

  try {
    const db = getDb();
    const today = israelToday();
    const pack = dataPack(db, today);
    const skill = readFileSync(join(process.cwd(), '.claude', 'skills', 'ask', 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '');
    const convo = history.map((h) => `${h.role === 'user' ? 'בעל העסק' : 'אתה'}: ${h.text}`).join('\n');
    const base = `${skill}\n\n${INJECTION_NOTE}\n\n## הסכמה\n${SCHEMA_DOC}\n\n## dataPack\n\`\`\`json\n${JSON.stringify(pack)}\n\`\`\`\n${convo ? `\n## השיחה עד כה\n${convo}\n` : ''}\n## השאלה\n${question}`;
    const first = runClaude(base, { timeoutMs: 3 * 60 * 1000 });
    if (!first.ok) return Response.json({ error: first.error }, { status: 502 });
    let reply = parseReply(first.text);
    let sql = null; let rows = null;
    if (reply.sql) {
      sql = reply.sql;
      let result;
      try { result = runReadOnly(DB_PATH, sql); rows = result.rows; }
      catch (e) { result = { error: String(e.message || e) }; }
      const second = runClaude(`${base}\n\n## השאילתה שביקשת\n\`\`\`sql\n${sql}\n\`\`\`\n## התוצאה\n\`\`\`json\n${JSON.stringify(result).slice(0, 60000)}\n\`\`\`\n\nעכשיו ענה לשאלה. בלי בלוק SQL נוסף.`, { timeoutMs: 3 * 60 * 1000 });
      if (!second.ok) return Response.json({ error: second.error }, { status: 502 });
      reply = parseReply(second.text);
      if (reply.sql) reply = { answer: 'לא הצלחתי לענות מהנתונים שיש לי על השאלה הזאת.' };
    }
    return Response.json({ ok: true, answer: reply.answer, sql, rows: rows ? rows.slice(0, 50) : null, asOf: pack.lastBankSync });
  } catch (err) { return Response.json({ error: String(err?.message || err) }, { status: 500 }); }
}
