// Learn recurring bank movements from history, so the 30/60/90-day forecast
// does not depend on anyone hand-filling config/recurring.json.
//
// A counterparty is "recurring" when, over the last LOOKBACK months, it shows
// up in at least MIN_MONTHS distinct months, on a stable day of month
// (within DAY_TOL of the median) and a stable amount (within AMOUNT_TOL of the
// median). Pure function over rows; DB access stays in lib/queries.js.

export const LOOKBACK_MONTHS = 6;
export const MIN_MONTHS = 3;
export const DAY_TOL = 4;
export const AMOUNT_TOL = 0.25;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Strip digits and reference noise so "העברה 1234 חברת X" and "העברה 5678 חברת X" group together.
export function normalizeName(name) {
  return String(name || '')
    .replace(/[\d/.\-:#*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// rows: [{ date, amount, counterparty, bucket }] — checking account, any sign.
export function detectRecurring(rows, { today, lookbackMonths = LOOKBACK_MONTHS, minMonths = MIN_MONTHS } = {}) {
  const cutoff = shiftMonth(today.slice(0, 7), -(lookbackMonths - 1));
  const groups = new Map();
  for (const row of rows) {
    const ym = row.date.slice(0, 7);
    if (ym < cutoff) continue;
    const key = `${normalizeName(row.counterparty)}|${row.amount < 0 ? 'out' : 'in'}`;
    if (!key.startsWith('|')) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
  }
  const out = [];
  for (const [key, rs] of groups) {
    // one representative per month: the largest movement that month
    const byMonth = new Map();
    for (const row of rs) {
      const ym = row.date.slice(0, 7);
      const cur = byMonth.get(ym);
      if (!cur || Math.abs(row.amount) > Math.abs(cur.amount)) byMonth.set(ym, row);
    }
    if (byMonth.size < minMonths) continue;
    const reps = [...byMonth.values()];
    const days = reps.map((x) => Number(x.date.slice(8, 10)));
    const amounts = reps.map((x) => x.amount);
    const dayMed = Math.round(median(days));
    const amtMed = median(amounts);
    const dayOk = days.filter((d) => Math.abs(d - dayMed) <= DAY_TOL).length / days.length;
    const amtOk = amounts.filter((a) => Math.abs(a - amtMed) <= Math.abs(amtMed) * AMOUNT_TOL).length / amounts.length;
    if (dayOk < 0.75 || amtOk < 0.75) continue;
    // must also be recent: seen in one of the last two months
    const last = [...byMonth.keys()].sort().pop();
    if (last < shiftMonth(today.slice(0, 7), -1)) continue;
    // Cadence: every month, or every other month (VAT for bi-monthly filers).
    const monthsSeen = [...byMonth.keys()].sort();
    const gaps = monthsSeen.slice(1).map((m, i) => monthIndex(m) - monthIndex(monthsSeen[i]));
    const every = gaps.length >= 2 && gaps.every((g) => g === 2) ? 2 : 1;
    const newest = reps.sort((a, b) => b.date.localeCompare(a.date))[0];
    out.push({
      key,
      name: newest.counterparty,
      day: dayMed,
      amount: Math.round(amtMed),
      bucket: newest.bucket || null,
      months: byMonth.size,
      confidence: Math.round(((dayOk + amtOk) / 2) * 100),
      lastSeen: newest.date,
      every,
      anchorMonth: monthsSeen[monthsSeen.length - 1],
      learned: true,
    });
  }
  return out.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

const monthIndex = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7));

export function shiftMonth(ym, n) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7)) - 1 + n;
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 7);
}
