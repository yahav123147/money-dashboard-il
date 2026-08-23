import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DB_PATH = process.env.MONEY_DB_PATH || join(ROOT, 'data', 'money.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bank_transactions (
  id TEXT PRIMARY KEY, account_id TEXT, account_number TEXT, account_type TEXT,
  provider TEXT, date TEXT, month TEXT, amount REAL, currency TEXT,
  counterparty TEXT, raw_desc TEXT, status TEXT,
  side TEXT, bucket TEXT, bucket_group TEXT, sub_bucket TEXT, expense_channel TEXT, raw_json TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_tx_month ON bank_transactions(month);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, provider TEXT, number TEXT, type TEXT, name TEXT,
  currency TEXT, balance REAL, balance_date TEXT, credit_limit REAL,
  securities_value REAL, raw_json TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS balance_snapshots (
  snap_date TEXT, account_id TEXT, currency TEXT, balance REAL,
  PRIMARY KEY (snap_date, account_id, currency));
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, ts TEXT, ok INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS counterparties (
  name TEXT PRIMARY KEY, first_seen TEXT, last_seen TEXT, tx_count INTEGER);
CREATE TABLE IF NOT EXISTS cardcom_sales (
  deal_id TEXT PRIMARY KEY, dt TEXT, date TEXT, amount REAL,
  product TEXT, product_raw TEXT, product_source TEXT, updated_at TEXT,
  acquirer TEXT, payments INTEGER, first_payment REAL, const_payment REAL);
CREATE INDEX IF NOT EXISTS idx_cc_date ON cardcom_sales(date);
`;

export function openDb(path = DB_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000'); // two writers (API + a script) wait instead of failing
  db.exec(SCHEMA);
  const txCols = db.prepare('PRAGMA table_info(bank_transactions)').all().map((c) => c.name);
  if (!txCols.includes('sub_bucket')) {
    db.exec('ALTER TABLE bank_transactions ADD COLUMN sub_bucket TEXT');
  }
  if (!txCols.includes('expense_channel')) {
    db.exec('ALTER TABLE bank_transactions ADD COLUMN expense_channel TEXT');
  }
  const ccCols = db.prepare('PRAGMA table_info(cardcom_sales)').all().map((c) => c.name);
  for (const [col, type] of [['acquirer', 'TEXT'], ['payments', 'INTEGER'], ['first_payment', 'REAL'], ['const_payment', 'REAL']]) {
    if (!ccCols.includes(col)) db.exec(`ALTER TABLE cardcom_sales ADD COLUMN ${col} ${type}`);
  }
  return db;
}

export function upsertTx(db, row) {
  db.prepare(`
    INSERT INTO bank_transactions
      (id, account_id, account_number, account_type, provider, date, month, amount,
       currency, counterparty, raw_desc, status, side, bucket, bucket_group, raw_json, updated_at)
    VALUES
      (@id, @account_id, @account_number, @account_type, @provider, @date, @month, @amount,
       @currency, @counterparty, @raw_desc, @status, @side, @bucket, @bucket_group, @raw_json, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      amount=excluded.amount, currency=excluded.currency, date=excluded.date, month=excluded.month,
      counterparty=excluded.counterparty, raw_desc=excluded.raw_desc, status=excluded.status,
      side=excluded.side, bucket=excluded.bucket, bucket_group=excluded.bucket_group,
      raw_json=excluded.raw_json, updated_at=datetime('now')
  `).run(row);
}


// PENDING rows get a NEW provider id on every fetch, so yesterday's copies are
// never updated in place: they linger as duplicates and — once the charge
// settles under a final BOOKED id — as ghosts that double-count forever.
// After each transactions pull: drop PENDING rows the provider no longer
// reports (currentIds = ids in this pull), then collapse any remaining
// duplicates on (account, date, amount, counterparty), keeping the newest row.
export function cleanupPendingRows(db, currentIds) {
  const stale = db.prepare(`
    DELETE FROM bank_transactions
    WHERE status='PENDING' AND id NOT IN (SELECT value FROM json_each(?))
  `).run(JSON.stringify(currentIds ?? []));
  // Keep the newest by rowid, which is insertion order. `id` is the provider's
  // TEXT key, so MAX(id) picks the lexicographically largest string, which has
  // nothing to do with time.
  const dupes = db.prepare(`
    DELETE FROM bank_transactions
    WHERE status='PENDING' AND rowid NOT IN (
      SELECT MAX(rowid) FROM bank_transactions WHERE status='PENDING'
      GROUP BY account_id, date, amount, counterparty)
  `).run();
  return { stale: stale.changes, dupes: dupes.changes };
}

export function logSync(db, source, ok, note = '') {
  db.prepare(`INSERT INTO sync_log (source, ts, ok, note) VALUES (?, datetime('now'), ?, ?)`)
    .run(source, ok ? 1 : 0, note);
}

export function refreshCountThisMonth(db) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM sync_log
    WHERE source='financy_refresh' AND ok=1
      AND strftime('%Y-%m', ts) = strftime('%Y-%m', 'now')
  `).get().n;
}

// Rebuild the counterparties rollup from bank_transactions. Cheap enough to
// run after every sync; the classifier and future UI autocomplete read it.
export function rebuildCounterparties(db) {
  db.exec('DELETE FROM counterparties');
  db.prepare(`
    INSERT INTO counterparties (name, first_seen, last_seen, tx_count)
    SELECT counterparty, MIN(date), MAX(date), COUNT(*)
    FROM bank_transactions
    WHERE counterparty IS NOT NULL AND counterparty != '' AND date IS NOT NULL
    GROUP BY counterparty
  `).run();
}
