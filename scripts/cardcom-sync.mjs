#!/usr/bin/env node
// CardCom sales sync (optional module).
// Pulls transactions from CardCom v11 ListTransactions (read-only) into cardcom_sales.
// Default range: today (Israel calendar day). --backfill N pulls the last N days;
// the first-ever run (empty table) backfills 7 days on its own.
//
// Endpoint: POST https://secure.cardcom.solutions/api/v11/Transactions/ListTransactions
//   request:  ApiName, ApiPassword, FromDate "DDMMYYYY", ToDate "DDMMYYYY", Page, Page_size
//   response: Tranzactions[] with TranzactionId, Amount, CreateDate "YYYY-MM-DDTHH:mm:ss",
//             IsRefund, CustomFields[] (Id = config.productFieldId carries the product name)
//
// PRIVACY: the CardCom payload carries the buyer's name, ID number, phone and
// email. We keep only deal id, time, amount and product name. Nothing else is
// stored, logged or printed.

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getSecret } from './lib/secrets.mjs';
import { openDb, logSync } from './lib/db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_URL = 'https://secure.cardcom.solutions/api/v11/Transactions/ListTransactions';
const PAGE_SIZE = 2000;
const MAX_PAGES = 10;

export function loadCardcomConfig(root = ROOT) {
  try {
    return JSON.parse(readFileSync(join(root, 'config', 'cardcom.json'), 'utf8'));
  } catch {
    return { enabled: false, productFieldId: 24, amountNames: {}, unknownLabel: 'אחר' };
  }
}

// --- dates (Israel calendar day, whatever timezone the machine runs in) ---
export const israelDay = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d); // YYYY-MM-DD
const daysAgoIsrael = (n) => israelDay(new Date(Date.now() - n * 86400000));
// CardCom wants DDMMYYYY
export const toCardcomDate = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${d}${m}${y}`;
};

// --- product name resolution ---
export function productRaw(tx, fieldId) {
  const cf = Array.isArray(tx?.CustomFields) ? tx.CustomFields : [];
  const f = cf.find((x) => Number(x?.Id ?? x?.FieldId) === Number(fieldId));
  const v = f ? String(f.Value ?? f.FieldValue ?? '').trim() : '';
  return v || null;
}

export function resolveProduct({ amount, raw }, cfg) {
  if (raw) return { product: raw, source: 'custom_field' };
  const byAmount = cfg?.amountNames?.[String(amount)];
  if (byAmount) return { product: byAmount, source: 'amount_rule' };
  return { product: cfg?.unknownLabel || 'אחר', source: 'unknown' };
}

// Turn one CardCom transaction into the row we keep. Exported for tests.
export function toRow(tx, cfg) {
  const amount = Number(tx.Amount) || 0;
  const dt = String(tx.CreateDate || '');
  const raw = productRaw(tx, cfg.productFieldId ?? 24);
  const { product, source } = resolveProduct({ amount, raw }, cfg);
  return {
    deal_id: String(tx.TranzactionId),
    dt,
    date: dt.slice(0, 10),
    amount,
    product,
    product_raw: raw,
    product_source: source,
  };
}

// product / product_source are sticky: a resolved name is never overwritten by
// an unresolved one from a later run (SQLite: bare column = existing row).
export const CARDCOM_UPSERT_SQL = `
  INSERT INTO cardcom_sales (deal_id, dt, date, amount, product, product_raw, product_source, updated_at)
  VALUES (@deal_id, @dt, @date, @amount, @product, @product_raw, @product_source, datetime('now'))
  ON CONFLICT(deal_id) DO UPDATE SET
    dt=excluded.dt, date=excluded.date, amount=excluded.amount,
    product        = CASE WHEN excluded.product_source = 'unknown' THEN product        ELSE excluded.product        END,
    product_raw    = excluded.product_raw,
    product_source = CASE WHEN excluded.product_source = 'unknown' THEN product_source ELSE excluded.product_source END,
    updated_at     = datetime('now')
`;

async function fetchTransactions(fromIso, toIso) {
  const apiName = getSecret('CARDCOM_API_NAME');
  const apiPassword = getSecret('CARDCOM_API_PASSWORD');
  if (!apiName || !apiPassword) throw new Error('חסרים מפתחות קארדקום (CARDCOM_API_NAME / CARDCOM_API_PASSWORD). הרץ /setup.');
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ApiName: apiName, ApiPassword: apiPassword,
        FromDate: toCardcomDate(fromIso), ToDate: toCardcomDate(toIso),
        Page: page, Page_size: PAGE_SIZE,
      }),
    });
    if (!res.ok) throw new Error(`CardCom HTTP ${res.status}`);
    const data = await res.json();
    if (data.ResponseCode !== 0 && data.ResponseCode !== undefined) {
      throw new Error(`CardCom ResponseCode ${data.ResponseCode}: ${data.Description || ''}`);
    }
    const txs = data.Tranzactions || [];
    all.push(...txs);
    if (txs.length < PAGE_SIZE) break;
  }
  return all;
}

async function main() {
  const cfg = loadCardcomConfig();
  if (!cfg.enabled) {
    console.log('קארדקום לא מופעל (config/cardcom.json enabled=false). מדלג.');
    return;
  }
  const db = openDb();
  const argv = process.argv.slice(2);
  const bfIdx = argv.indexOf('--backfill');
  let backfillDays = 0;
  if (bfIdx !== -1) {
    const n = parseInt(argv[bfIdx + 1], 10);
    backfillDays = Number.isFinite(n) && n > 0 ? n : 7;
  } else {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM cardcom_sales').get();
    if (n === 0) backfillDays = 7;
  }
  const today = israelDay();
  const fromIso = backfillDays > 0 ? daysAgoIsrael(backfillDays) : today;

  try {
    const txs = await fetchTransactions(fromIso, today);
    const rows = txs.filter((t) => !t.IsRefund).map((t) => toRow(t, cfg));
    const upsert = db.prepare(CARDCOM_UPSERT_SQL);
    db.transaction((rs) => { for (const r of rs) upsert.run(r); })(rows);
    const t = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM cardcom_sales WHERE date=?').get(today);
    logSync(db, 'cardcom', true, `range ${fromIso}..${today}, fetched ${txs.length}, upserted ${rows.length}`);
    console.log(`טווח ${fromIso} עד ${today}: ${rows.length} עסקאות עודכנו (בלי זיכויים)`);
    console.log(`היום (${today}): ${t.n} עסקאות, סה"כ ₪${t.total.toLocaleString('he-IL')}`);
  } catch (err) {
    logSync(db, 'cardcom', false, String(err.message || err));
    console.error('cardcom-sync failed:', err.message || err);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
