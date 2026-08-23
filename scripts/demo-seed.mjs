#!/usr/bin/env node
// Demo mode: a FICTIONAL business with eight months of realistic, deterministic
// data, so the dashboard can be taught, demoed and screen-recorded without
// exposing anyone's real numbers. Same generator every run — recordings and
// live demos always match.
//
// Usage: npm run demo                       (עוסק מורשה, the default story)
//        npm run demo -- --entity=patur     (near the turnover ceiling → alert)
//        npm run demo -- --entity=company   (corporate tax + owner draws)
//        npm run demo -- --force            (overwrite existing data/config)
//
// Guards: refuses to touch a database that already has rows, or a settings
// file that already names an entity, unless --force is given. Reset with:
//   git checkout config/ && rm -f data/money.db*
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb, upsertTx, rebuildCounterparties } from './lib/db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Deterministic PRNG — the whole point of a demo is that it looks the same
// on stage as it did in rehearsal.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Israel calendar day, the same clock the dashboard reads.
function israelToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
}

// The eight months ending at `today`. Written as a literal list once, which
// meant the demo kept seeding 2026 for ever: on 1 January 2027 the dashboard,
// which only ever shows the current tax year, would have opened on an empty
// expense panel and a null tax bridge. A demo has to follow the clock.
export function demoMonths(today, count = 8) {
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// Fictional Israeli clients — invented names, no real business implied.
const CLIENTS = [
  'סטודיו פילאטיס הרמוניה', 'מאפיית הבוקר בע"מ', 'קליניקת עד הלום',
  'חנות הצמחים של גיל', 'משרד אדריכלות קו ונוף', 'צילום אירועים אלף',
  'יעוץ ארגוני צפון', 'בית קפה הרחוב השלישי',
];

export function seedDemo(db, entity = 'murshe', today = israelToday()) {
  const MONTHS = demoMonths(today);
  const rnd = mulberry32(42);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const jitter = (base, pct = 0.2) => Math.round(base * (1 + (rnd() * 2 - 1) * pct));
  let seq = 0;
  const row = (date, amount, counterparty, bucket, group, extra = {}) => upsertTx(db, {
    id: `demo-${++seq}`, account_id: 'demo-checking', account_number: '123456/78',
    account_type: 'CHECKING', provider: 'demo-bank', date, month: date.slice(0, 7),
    amount, currency: 'ILS', counterparty, raw_desc: counterparty,
    status: 'completed', side: amount >= 0 ? 'in' : 'out',
    bucket, bucket_group: group, raw_json: '{}', ...extra,
  });
  // upsertTx deliberately does not write sub_bucket (production sets it in the
  // classify pass), so the demo sets it explicitly right after the insert.
  const card = (date, amount, counterparty, sub) => {
    const id = `demo-${++seq}`;
    upsertTx(db, {
      id, account_id: 'demo-card', account_number: '****4321',
      account_type: 'CARD', provider: 'demo-bank', date, month: date.slice(0, 7),
      amount, currency: 'ILS', counterparty, raw_desc: counterparty,
      status: 'completed', side: 'out', bucket: 'cards',
      bucket_group: ['personal', 'charity', 'other_venture'].includes(sub) ? 'below_line' : 'expense',
      raw_json: '{}',
    });
    db.prepare('UPDATE bank_transactions SET sub_bucket = ? WHERE id = ?').run(sub, id);
  };

  // Revenue scale per entity: patur sits at ~84% of the ₪122,833 ceiling over
  // the seeded window so the ceiling alert has something to teach; company
  // runs bigger.
  const monthlyRevenue = { patur: 13000, murshe: 52000, company: 110000 }[entity];

  for (const m of MONTHS) {
    const partial = m === today.slice(0, 7);
    const payments = partial ? 3 : (entity === 'patur' ? 3 : 6);
    for (let i = 0; i < payments; i++) {
      const day = String(2 + Math.floor(rnd() * (partial ? 15 : 26))).padStart(2, '0');
      row(`${m}-${day}`, jitter(monthlyRevenue / payments), pick(CLIENTS), 'direct', 'revenue');
    }

    if (entity !== 'patur') {
      row(`${m}-03`, -jitter(entity === 'company' ? 34000 : 11500, 0.1), 'פרילנס עיצוב ותוכן', 'team', 'expense');
      row(`${m}-10`, -jitter(1250, 0.1), 'הפקדות קופת גמל', 'pension', 'expense');
    }
    if (entity === 'company') {
      row(`${m}-05`, -18000, 'משיכת בעלים', 'owner_draw', 'below_line');
    }

    // The state: advances monthly, VAT bi-monthly (periods Jan-Feb, Mar-Apr...
    // paid on the 15th of the following month, i.e. odd months), national
    // insurance monthly.
    row(`${m}-14`, -jitter(entity === 'patur' ? 520 : 2600, 0.1), 'מס הכנסה מקדמות', 'tax_advance', 'expense');
    if (Number(m.slice(5)) % 2 === 1 && entity !== 'patur') {
      row(`${m}-15`, -jitter(13200, 0.08), 'מע"מ תשלום', 'tax_vat', 'expense');
    }
    row(`${m}-16`, -jitter(entity === 'patur' ? 380 : 1750, 0.1), 'ביטוח לאומי', 'tax_social', 'expense');

    // Card spend that exercises the sub-classifier and the tax-recognition rules.
    card(`${m}-06`, -jitter(3200, 0.3), 'FACEBK ADS', 'ads');
    card(`${m}-07`, -jitter(1400, 0.3), 'GOOGLE ADS', 'ads');
    card(`${m}-08`, -390, 'OPENAI', 'tools');
    card(`${m}-08`, -92, 'CLAUDE.AI SUBSCRIPTION', 'tools');
    card(`${m}-09`, -jitter(880, 0.05), 'ארנונה עירונית', 'personal');   // home-office 30% recognition
    card(`${m}-09`, -jitter(430, 0.25), 'חברת החשמל', 'personal');
    card(`${m}-09`, -179, 'בזק תשלום חודשי', 'personal');                 // landline 80% rule
    card(`${m}-12`, -jitter(640, 0.4), 'סופר השכונה', 'other_business');

    // Two vendors the rules do NOT know — the calibration lesson of /setup step 7.
    if (!partial) {
      row(`${m}-19`, -jitter(1450, 0.3), 'הדפסות מהיר בע"מ', 'unclassified', 'unclassified');
      row(`${m}-22`, -jitter(780, 0.3), 'שליחויות אקספרס דרום', 'unclassified', 'unclassified');
    }
  }

  // Balances for the hero row, and two future-dated rows so the 30-day
  // cashflow has a story to tell.
  const accounts = db.prepare(`
    INSERT INTO accounts (id, provider, number, type, name, currency, balance,
      balance_date, credit_limit, securities_value, raw_json, updated_at)
    VALUES (@id, 'demo-bank', @number, @type, @name, 'ILS', @balance, @bd, @cl, NULL, '{}', datetime('now'))
    ON CONFLICT(id) DO UPDATE SET balance=excluded.balance, balance_date=excluded.balance_date
  `);
  accounts.run({ id: 'demo-checking', number: '123456/78', type: 'CHECKING', name: 'עו"ש עסקי', balance: 68450, bd: today, cl: null });
  accounts.run({ id: 'demo-card', number: '****4321', type: 'CARD', name: 'כרטיס עסקי', balance: 7830, bd: today, cl: 40000 });
  const snap = db.prepare(`
    INSERT INTO balance_snapshots (snap_date, account_id, currency, balance) VALUES (?, ?, 'ILS', ?)
    ON CONFLICT(snap_date, account_id, currency) DO UPDATE SET balance=excluded.balance
  `);
  snap.run(today, 'demo-checking', 68450);
  snap.run(today, 'demo-card', 7830);

  const future = (offsetDays, amount, counterparty, bucket, group) => {
    const d = new Date(today + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + offsetDays);
    row(d.toISOString().slice(0, 10), amount, counterparty, bucket, group, { status: 'PENDING' });
  };
  future(4, jitter(monthlyRevenue / 4), pick(CLIENTS), 'direct', 'revenue');
  future(9, -jitter(entity === 'patur' ? 520 : 2600, 0.1), 'מס הכנסה מקדמות', 'tax_advance', 'expense');

  rebuildCounterparties(db);
  return { rows: seq, entity };
}

function writeDemoConfig(entity) {
  const sPath = join(ROOT, 'config', 'settings.json');
  const s = JSON.parse(readFileSync(sPath, 'utf8'));
  s.entityType = entity;
  s.vatRate = entity === 'patur' ? 1.0 : 1.18;
  s.advanceRatePct = entity === 'patur' ? 3.0 : 5.0;
  s.creditPoints = entity === 'company' ? null : 2.25;
  writeFileSync(sPath, JSON.stringify(s, null, 2) + '\n');

  const tPath = join(ROOT, 'config', 'tax-rules.json');
  const t = JSON.parse(readFileSync(tPath, 'utf8'));
  t.homeOffice.businessRatio = 0.3;
  writeFileSync(tPath, JSON.stringify(t, null, 2) + '\n');
  const chPath = join(ROOT, 'config', 'channels.json');
  const ch = JSON.parse(readFileSync(chPath, 'utf8'));
  ch.channels = ['קורסים', 'מנויים', 'ייעוץ', 'מוצרים דיגיטליים'];
  ch.productRules = [
    { match: ['קורס'], channel: 'קורסים' }, { match: ['מנוי'], channel: 'מנויים' },
    { match: ['ייעוץ'], channel: 'ייעוץ' }, { match: ['ספר'], channel: 'מוצרים דיגיטליים' },
  ];
  ch.bankRules = [
    { match: ['סטודיו פילאטיס', 'מאפיית', 'קליניקת', 'יעוץ ארגוני'], channel: 'ייעוץ' },
    { match: ['משרד אדריכלות', 'צילום אירועים'], channel: 'קורסים' },
    { match: ['בית קפה'], channel: 'מנויים' },
  ]; // 'חנות הצמחים' left unmatched on purpose, so the assign flow has something to show
  writeFileSync(chPath, JSON.stringify(ch, null, 2) + '\n');
  const cPath = join(ROOT, 'config', 'cardcom.json');
  const c = JSON.parse(readFileSync(cPath, 'utf8'));
  c.enabled = true;
  c.settlement = { ...(c.settlement || {}), feePct: 1.2 };
  writeFileSync(cPath, JSON.stringify(c, null, 2) + '\n');
}

// Fictional CardCom sales for the last 10 days, so the sales panel has
// something to show in demo mode. Products are invented; amounts are round.
function shiftDate(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function seedSales(db, today) {
  const PRODUCTS = [
    ['קורס דיגיטלי', 490], ['מנוי חודשי', 149], ['ייעוץ שעה', 600], ['ספר דיגיטלי', 39],
  ];
  const ins = db.prepare(`
    INSERT OR REPLACE INTO cardcom_sales (deal_id, dt, date, amount, product, product_raw, product_source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'custom_field', datetime('now'))`);
  let n = 0;
  for (let back = 0; back < 10; back++) {
    const date = shiftDate(today, -back);
    const perDay = 2 + ((back * 7) % 5); // 2..6 sales, deterministic
    for (let i = 0; i < perDay; i++) {
      const [name, amount] = PRODUCTS[(back + i * 3) % PRODUCTS.length];
      const hh = String(8 + ((i * 5 + back) % 12)).padStart(2, '0');
      ins.run(`demo-${date}-${i}`, `${date}T${hh}:${String((i * 17) % 60).padStart(2, '0')}:00`, date, amount, name, name);
      n++;
    }
  }
  db.prepare(`INSERT INTO sync_log (source, ts, ok, note) VALUES ('cardcom', datetime('now'), 1, 'demo seed')`).run();

  // Matching bank credits: each sales day lands the next day net of a 1.2% fee,
  // except one day (7 days back) that "never arrived" — so the reconciliation
  // panel has a real finding to show. Today's and yesterday's are still pending.
  const days = db.prepare(`SELECT date, SUM(amount) AS total FROM cardcom_sales GROUP BY date`).all();
  for (const d of days) {
    const back = Math.round((new Date(`${today}T12:00:00Z`) - new Date(`${d.date}T12:00:00Z`)) / 86400000);
    if (back < 2 || back === 7) continue;
    const landed = shiftDate(d.date, 1);
    upsertTx(db, {
      id: `demo-settle-${d.date}`, account_id: 'demo-checking', account_number: '123456/78', account_type: 'CHECKING',
      provider: 'demo', date: landed, month: landed.slice(0, 7), amount: Math.round(d.total * 0.988 * 100) / 100,
      currency: 'ILS', counterparty: 'קארדקום בע"מ', raw_desc: 'זיכוי קארדקום', status: 'completed',
      side: 'in', bucket: 'revenue', bucket_group: 'revenue', raw_json: '{}',
    });
  }
  return n;
}

function main() {
  const entity = (process.argv.find((a) => a.startsWith('--entity=')) || '--entity=murshe').split('=')[1];
  const force = process.argv.includes('--force');
  if (!['patur', 'murshe', 'company'].includes(entity)) {
    console.error(`entity לא מוכר: ${entity} (patur | murshe | company)`);
    process.exitCode = 1;
    return;
  }
  const db = openDb();
  try {
    const existing = db.prepare('SELECT COUNT(*) n FROM bank_transactions').get().n;
    const settings = JSON.parse(readFileSync(join(ROOT, 'config', 'settings.json'), 'utf8'));
    if ((existing > 0 || settings.entityType) && !force) {
      console.error(`יש כבר נתונים (${existing} תנועות) או קונפיג מוגדר (entityType=${settings.entityType}).`);
      console.error('מצב הדגמה לא דורס נתונים אמיתיים. אם זו באמת הכוונה: npm run demo -- --force');
      console.error('לאיפוס מלא: git checkout config/ && rm -f data/money.db*');
      process.exitCode = 1;
      return;
    }
    if (force && existing > 0) {
      db.exec('DELETE FROM bank_transactions; DELETE FROM accounts; DELETE FROM balance_snapshots; DELETE FROM counterparties; DELETE FROM cardcom_sales;');
    }
    const today = israelToday();
    const { rows } = seedDemo(db, entity, today);
    const sales = seedSales(db, today);
    const months = demoMonths(today);
    writeDemoConfig(entity);
    console.log(`מכירות קארדקום לדוגמה: ${sales} עסקאות ב-10 ימים.`);
    console.log(`מצב הדגמה מוכן: עסק פיקטיבי (${entity}), ${rows} תנועות, ${months[0]} עד ${months[months.length - 1]}.`);
    if (months[0].slice(0, 4) !== months[months.length - 1].slice(0, 4)) {
      console.log('שים לב: החלון חוצה שנת מס. הדשבורד מציג את שנת המס הנוכחית בלבד, ולכן חלק מהחודשים לא יופיעו בפאנל ההוצאות ובגשר המס.');
    }
    console.log('הרץ: npm run dev  →  http://localhost:8423');
    console.log('לאיפוס: git checkout config/ && rm -f data/money.db*');
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
