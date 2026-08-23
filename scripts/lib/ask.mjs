// "שאל את הנתונים": the data pack a question is answered from, the
// read-only escape hatch for questions the pack cannot answer, and the
// parsing of the model's reply. Pure over a db handle; the API route wires
// it to claude -p through the same preflight as the other agents.
import Database from 'better-sqlite3';

const r = (x) => Math.round(x || 0);

// 13 months of the business at the grain most questions need: money in and
// out per month by category, balances, card sales, taxes paid, biggest
// names. Compact on purpose (a few KB), so the answer is one model call.
export function dataPack(db, today, months = 13) {
  const ym = today.slice(0, 7);
  const y = Number(ym.slice(0, 4)); const m = Number(ym.slice(5, 7));
  const from = `${m - months + 1 <= 0 ? y - 1 : y}-${String(((m - months) % 12 + 12) % 12 + 1).padStart(2, '0')}`;
  const byMonth = {};
  const rows = db.prepare(`
    SELECT month, bucket_group, bucket, SUM(amount) s, COUNT(*) n FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS' AND month >= ? AND month <= ? AND status != 'PENDING'
    GROUP BY month, bucket_group, bucket ORDER BY month
  `).all(from, ym);
  // Operating money (revenue / refunds / expenses / unclassified) apart from
  // below-the-line and internal movements (securities, owner money, card
  // settlements, FX): "how much came in" means the first, and the model
  // should not have to subtract the second by eye.
  const OPERATING = new Set(['revenue', 'refund', 'expense', 'unclassified']);
  for (const x of rows) {
    const mo = byMonth[x.month] || (byMonth[x.month] = { in: 0, out: 0, inBy: {}, outBy: {}, other: { in: 0, out: 0, by: {} } });
    const key = x.bucket || x.bucket_group;
    if (OPERATING.has(x.bucket_group)) {
      if (x.s >= 0) { mo.in += x.s; mo.inBy[key] = r((mo.inBy[key] || 0) + x.s); }
      else { mo.out += -x.s; mo.outBy[key] = r((mo.outBy[key] || 0) - x.s); }
    } else {
      if (x.s >= 0) mo.other.in += x.s; else mo.other.out += -x.s;
      mo.other.by[key] = r((mo.other.by[key] || 0) + x.s);
    }
  }
  for (const mo of Object.values(byMonth)) { mo.in = r(mo.in); mo.out = r(mo.out); mo.net = r(mo.in - mo.out); mo.other.in = r(mo.other.in); mo.other.out = r(mo.other.out); mo.totalIn = r(mo.in + mo.other.in); mo.totalOut = r(mo.out + mo.other.out); }
  const top = (sign) => db.prepare(`
    SELECT month, counterparty, SUM(amount) s, COUNT(*) n FROM bank_transactions
    WHERE account_type='CHECKING' AND currency='ILS' AND month >= ? AND month <= ? AND amount ${sign} 0 AND counterparty != ''
      AND bucket_group IN ('revenue','refund','expense','unclassified')
    GROUP BY month, counterparty ORDER BY month, ABS(SUM(amount)) DESC
  `).all(from, ym);
  const topIn = {}; const topOut = {};
  for (const x of top('>')) { (topIn[x.month] = topIn[x.month] || []); if (topIn[x.month].length < 6) topIn[x.month].push({ name: x.counterparty, amount: r(x.s), n: x.n }); }
  for (const x of top('<')) { (topOut[x.month] = topOut[x.month] || []); if (topOut[x.month].length < 6) topOut[x.month].push({ name: x.counterparty, amount: r(-x.s), n: x.n }); }
  const cards = db.prepare(`
    SELECT month, COALESCE(sub_bucket,'other_business') sub, SUM(amount) s FROM bank_transactions
    WHERE account_type='CARD' AND month >= ? AND month <= ? AND amount < 0 GROUP BY month, sub
  `).all(from, ym);
  const cardBy = {};
  for (const x of cards) (cardBy[x.month] = cardBy[x.month] || {})[x.sub] = r(-x.s);
  let sales = {};
  try {
    for (const x of db.prepare(`SELECT substr(date,1,7) month, COUNT(*) n, SUM(amount) s FROM cardcom_sales WHERE date >= ? GROUP BY 1`).all(from + '-01')) sales[x.month] = { count: x.n, total: r(x.s) };
    const byProduct = db.prepare(`SELECT substr(date,1,7) month, product, COUNT(*) n, SUM(amount) s FROM cardcom_sales WHERE date >= ? GROUP BY 1, 2`).all(from + '-01');
    for (const x of byProduct) { const mo = sales[x.month]; if (mo) (mo.byProduct = mo.byProduct || {})[x.product || 'לא ידוע'] = { count: x.n, total: r(x.s) }; }
  } catch { sales = {}; }
  const accounts = db.prepare(`SELECT type, currency, name, balance, balance_date FROM accounts ORDER BY type`).all()
    .map((a) => ({ type: a.type, currency: a.currency, name: a.name, balance: a.balance == null ? null : r(a.balance), asOf: a.balance_date }));
  const lastSync = db.prepare(`SELECT MAX(ts) ts FROM sync_log WHERE source='financy' AND ok=1`).get().ts;
  return {
    today, from, to: ym, currency: 'ILS',
    note: 'in/out = כסף תפעולי בעו"ש (הכנסות, הוצאות, החזרים, לא מסווג), בלי תנועות ממתינות. other = תנועות שאינן תפעוליות: ני"ע, כספי בעלים, חיובי כרטיס (card_settlement), המרות מט"ח; totalIn/totalOut כוללים אותן. cards = חיובי כרטיס לפי קטגוריה. sales = עסקאות קארדקום (לא כסף בבנק עד הזיכוי).',
    months: byMonth, topIn, topOut, cards: cardBy, sales, accounts, lastBankSync: lastSync,
  };
}

export const SCHEMA_DOC = `טבלאות (SQLite, קריאה בלבד):
bank_transactions(id, account_type 'CHECKING'|'CARD', date 'YYYY-MM-DD', month 'YYYY-MM', amount (חיובי=נכנס, שלילי=יוצא), currency, counterparty, raw_desc, status ('PENDING' = עתידי), bucket, bucket_group 'revenue'|'expense'|'refund'|'internal'|'below_line'|'unclassified', sub_bucket)
accounts(id, type, name, currency, balance, balance_date)
cardcom_sales(deal_id, date, amount, product, acquirer, payments)
sync_log(source, ts, ok)
classify_rules(side, match, bucket, bucket_group)`;

// One SELECT, on a fresh read-only connection, capped rows. Anything else
// is refused before it reaches SQLite.
export function runReadOnly(dbPath, sql, { maxRows = 200 } = {}) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(s)) throw new Error('מותר רק SELECT');
  if (/;/.test(s)) throw new Error('שאילתה אחת בלבד');
  if (/\b(attach|detach|pragma|insert|update|delete|drop|alter|create|replace|vacuum|reindex)\b/i.test(s)) throw new Error('שאילתה לקריאה בלבד');
  const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    ro.pragma('query_only = 1');
    const stmt = ro.prepare(s);
    if (!stmt.reader) throw new Error('השאילתה לא מחזירה שורות');
    const rows = stmt.all();
    return { rows: rows.slice(0, maxRows), truncated: rows.length > maxRows, total: rows.length };
  } finally { ro.close(); }
}

// The model may answer, or ask for one query first.
export function parseReply(text) {
  const t = String(text || '').trim();
  const sql = t.match(/```sql\s*([\s\S]*?)```/i);
  if (sql) return { sql: sql[1].trim() };
  return { answer: t.replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, ', ') };
}
