// Data-quality checks: the deterministic layer that catches the mistakes a
// dashboard makes when its inputs are off. Every check is pure (inputs in,
// findings out) so it can be tested without a database. computeQuality in
// lib/queries.js gathers the inputs.
//
// Severity: 'fix'  = the numbers on screen are likely wrong until this is handled
//           'warn' = the numbers are probably fine, but a setting looks off
//           'info' = worth knowing; nothing to do
// `area` says which screen number the finding moves: cashflow | tax | sales | general.
import { normalizeName } from './recurring-detect.mjs';

const r = (x) => Math.round(x);
const ils = (x) => `${r(Math.abs(x)).toLocaleString('he-IL')} ₪`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

// Manual recurring item vs learned one: same day (±4), similar amount (±25%),
// no bucket ownership to dedupe them → the forecast pays it twice.
export function checkRecurringDuplicates({ manual = [], learned = [] }) {
  const out = [];
  for (const m of manual) {
    for (const l of learned) {
      if (m.bucket && l.bucket && m.bucket === l.bucket) continue; // bucket rule already dedupes
      // Both classified, into different buckets: two different payments that
      // happen to share a day and a size (e.g. two taxes on the 20th-23rd).
      if (m.bucket && l.bucket && m.bucket !== l.bucket) continue;
      const dayOk = Math.abs((m.day || 0) - (l.day || 0)) <= 4;
      const amtOk = Math.abs(m.amount) > 0 && Math.abs(Math.abs(l.amount) - Math.abs(m.amount)) <= Math.abs(m.amount) * 0.25;
      const sameSign = Math.sign(m.amount) === Math.sign(l.amount);
      if (dayOk && amtOk && sameSign) {
        out.push({
          key: `rec_dup|${normalizeName(m.name)}|${normalizeName(l.name)}`,
          severity: 'fix', area: 'cashflow',
          title: 'תשלום קבוע שנספר פעמיים',
          text: `"${m.name}" (ידני, ${ils(m.amount)} ב-${m.day} לחודש) ו-"${l.name}" (נלמד מהבנק, ${ils(l.amount)} ב-${l.day}) נראים כמו אותו תשלום. התחזית סופרת את שניהם.`,
          action: 'פירוט ← תזרים ← לסמן "לא קבוע" על הפריט הנלמד, או למחוק את הידני',
          amount: r(Math.abs(m.amount)),
        });
      }
    }
  }
  return out;
}

// A manual item that has not shown up in the bank for 3+ months is probably
// no longer active; the forecast keeps paying it.
export function checkStaleManual({ manual = [], seenNames = new Set(), seenBuckets = new Set() }) {
  const out = [];
  for (const m of manual) {
    const nameSeen = seenNames.has(normalizeName(m.name));
    const bucketSeen = m.bucket ? seenBuckets.has(m.bucket) : false;
    if (!nameSeen && !bucketSeen) {
      out.push({
        key: `rec_stale|${normalizeName(m.name)}`,
        severity: 'warn', area: 'cashflow',
        title: 'תשלום קבוע שלא נראה בבנק',
        text: `"${m.name}" (${ils(m.amount)}) מוגדר כקבוע, אבל בשלושת החודשים האחרונים לא הייתה תנועה כזאת בבנק.`,
        action: 'אם הפסיק: למחוק מ-config/recurring.json. אם השם בבנק שונה: לעדכן את bucket',
        amount: r(Math.abs(m.amount)),
      });
    }
  }
  return out;
}

// Acquirers that have sales but whose money never landed in this account.
// Not an error (AmEx / PayPal often pay to another account), but the forecast
// and the "missing" line must not treat it as cash on the way.
export function checkAcquirersNeverLand({ byAcquirer = {}, labels = (k) => k }) {
  const out = [];
  for (const [acq, a] of Object.entries(byAcquirer)) {
    if ((a.expected || 0) > 0 && !(a.received > 0) && (a.periods || 0) >= 2) {
      out.push({
        key: `acq_never|${acq}`,
        severity: 'info', area: 'sales',
        title: `${labels(acq)}: הכסף לא מגיע לחשבון הזה`,
        text: `יש מכירות דרך ${labels(acq)} (${ils(a.expected)} צפויים) אבל אף זיכוי מהם לא נחת בחשבון המחובר. כנראה נכנס לחשבון אחר. התחזית לא סופרת את הכסף הזה.`,
        action: 'לוודא לאן הכסף הזה מגיע; אם לחשבון אחר, הכל בסדר',
        amount: r(a.expected),
      });
    }
  }
  return out;
}

// The day a tax actually leaves the bank vs the configured day. Off by more
// than 3 days → "paid" detection and the deadline line can both be wrong.
export function checkTaxDebitDays({ vatDays = [], advanceDays = [], vatDueDay, advanceDueDay }) {
  const out = [];
  const one = (days, configured, what, setting) => {
    if (days.length < 2 || configured == null) return;
    const med = median(days);
    if (Math.abs(med - configured) > 3) {
      out.push({
        key: `tax_day|${setting}`,
        severity: 'warn', area: 'tax',
        title: `${what}: היום בהגדרות לא תואם לבנק`,
        text: `${what} יורד בפועל סביב ה-${r(med)} לחודש (לפי ${days.length} חיובים), אבל בהגדרות כתוב ${configured}. זה יכול להציג תשלום כ"לא שולם" או להחמיץ אותו.`,
        action: `הגדרות ← ${setting} = ${r(med)}`,
        suggested: { setting, value: r(med) },
      });
    }
  };
  one(vatDays, vatDueDay, 'מע"מ', 'vatDueDay');
  one(advanceDays, advanceDueDay, 'מקדמת מס', 'advanceDueDay');
  return out;
}

// VAT actually paid vs what the rules compute, for closed periods that were
// paid. Consistently far apart → vatInput rules are off, and the "מע"מ" line
// is a guess.
export function checkVatEstimate({ periods = [] }) {
  const paid = periods.filter((p) => p.paid > 0 && p.net > 0);
  if (paid.length < 2) return [];
  const ratios = paid.map((p) => p.paid / p.net);
  const med = median(ratios);
  if (med > 0.6 && med < 1.6) return [];
  const dir = med > 1 ? 'גבוה' : 'נמוך';
  return [{
    key: 'vat_estimate_off',
    severity: 'warn', area: 'tax',
    title: 'הערכת המע"מ רחוקה ממה ששולם',
    text: `ב-${paid.length} תקופות אחרונות המע"מ ששולם בפועל היה ${dir} פי ${med.toFixed(1)} מההערכה של הדשבורד. כנראה חוקי מע"מ התשומות לא מכוונים לעסק הזה.`,
    action: 'לבדוק config/tax-rules.json ← vatInput מול דוח המע"מ של הרו"ח',
  }];
}

// Duplicate PENDING rows (same account, date, amount, counterparty) inflate
// the forecast.
export function checkPendingDuplicates({ dupes = 0, amount = 0 }) {
  if (!dupes) return [];
  return [{
    key: 'pending_dupes',
    severity: 'fix', area: 'cashflow',
    title: 'תנועות עתידיות כפולות',
    text: `${dupes === 1 ? 'תנועה עתידית אחת מופיעה' : `${dupes} תנועות עתידיות מופיעות`} פעמיים בבנק (${ils(amount)}). התחזית מתעלמת מהכפילות, אבל הסנכרון הבא אמור לנקות אותן.`,
    action: 'npm run sync',
    amount: r(Math.abs(amount)),
  }];
}

// First month of sales data that does not start on the 1st: its settlement
// row will look "partial" for a reason that is not missing money.
export function checkPartialFirstMonth({ firstSaleDate, mode }) {
  if (!firstSaleDate || mode !== 'monthly') return [];
  if (firstSaleDate.slice(8, 10) === '01') return [];
  return [{
    key: 'partial_first_month',
    severity: 'info', area: 'sales',
    title: 'החודש הראשון של המכירות חלקי',
    text: `נתוני המכירות מתחילים ב-${firstSaleDate.slice(8, 10)}.${firstSaleDate.slice(5, 7)}, לא בתחילת החודש. ההתאמה לחודש הזה תראה פער שאינו כסף חסר.`,
    action: 'אין מה לעשות; מהחודש הבא ההתאמה מלאה',
  }];
}

// Unclassified share of expenses over the last 3 months. Above 10% the tax
// estimate and the P&L are moving targets.
export function checkUnclassifiedShare({ unclassified = 0, total = 0, count = 0 }) {
  if (total <= 0) return [];
  const pct = (unclassified / total) * 100;
  if (pct < 10) return [];
  return [{
    key: 'unclassified_share',
    severity: pct >= 25 ? 'fix' : 'warn', area: 'tax',
    title: 'חלק גדול מההוצאות בלי סיווג',
    text: `${r(pct)}% מההוצאות בשלושת החודשים האחרונים (${ils(unclassified)}, ${count} תנועות) לא מסווגות. הערכת המס והרווח לא מדויקות עד שזה מטופל.`,
    action: 'פירוט ← הוצאות ← לשייך קטגוריה; או להוסיף חוק ב-config/rules.json',
    amount: r(unclassified),
  }];
}

// Foreign-currency accounts without a rate: their balance is counted at 1:1.
export function checkFxRate({ hasUsd = false, usdToIls = null }) {
  if (!hasUsd || usdToIls) return [];
  return [{
    key: 'fx_rate_missing',
    severity: 'fix', area: 'cashflow',
    title: 'חשבון במט"ח בלי שער',
    text: 'יש חשבון או כרטיס בדולרים, אבל לא הוגדר שער המרה. היתרה והוצאות המט"ח נספרות 1:1.',
    action: 'הגדרות ← usdToIls',
  }];
}

// Sync freshness for each source.
export function checkFreshness({ today, bankLastDate, cardcomEnabled = false, cardcomLastSync = null, daysBetween }) {
  const out = [];
  if (bankLastDate && daysBetween(bankLastDate, today) > 3) {
    out.push({
      key: 'bank_stale', severity: 'fix', area: 'general',
      title: 'נתוני הבנק לא עדכניים',
      text: `התנועה האחרונה מהבנק היא מ-${bankLastDate.slice(8, 10)}.${bankLastDate.slice(5, 7)}. היתרה והתחזית מתבססות על נתונים ישנים.`,
      action: 'npm run sync',
    });
  }
  if (cardcomEnabled && cardcomLastSync && daysBetween(cardcomLastSync.slice(0, 10), today) > 2) {
    out.push({
      key: 'cardcom_stale', severity: 'warn', area: 'sales',
      title: 'מכירות הקארדקום לא סונכרנו',
      text: `הסנכרון האחרון מקארדקום היה ב-${cardcomLastSync.slice(8, 10)}.${cardcomLastSync.slice(5, 7)}. מכירות מאז לא מופיעות.`,
      action: 'npm run sync:cardcom',
    });
  }
  return out;
}

// Roll the findings into one verdict and a forecast-confidence label.
export function summarizeQuality(findings) {
  const fix = findings.filter((f) => f.severity === 'fix').length;
  const warn = findings.filter((f) => f.severity === 'warn').length;
  const cashFix = findings.filter((f) => f.area === 'cashflow' && f.severity === 'fix').length;
  const cashWarn = findings.filter((f) => f.area === 'cashflow' && f.severity === 'warn').length;
  const verdict = fix ? 'fix' : warn ? 'check' : 'good';
  const confidence = cashFix ? 'low' : cashWarn ? 'medium' : 'high';
  const confidenceText = { high: 'התחזית מבוססת על נתונים נקיים', medium: 'התחזית סבירה; יש הגדרה אחת או שתיים לבדוק', low: 'התחזית עלולה להטעות עד שיטופלו הפריטים למטה' }[confidence];
  return { verdict, confidence, confidenceText, counts: { fix, warn, info: findings.length - fix - warn } };
}
