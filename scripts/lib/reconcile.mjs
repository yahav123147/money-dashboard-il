// CardCom ↔ bank reconciliation. Pure: takes sales-per-day and bank credits,
// returns one row per settlement period with a verdict. No DB access here so
// it can be tested with fixtures.
//
//   daily   : every sales day D expects one credit in [D+lag, D+lag+window]
//   monthly : every sales month expects credits in the following month
//             (dayOfMonth ±5 when set, otherwise the whole month)
// Expected net = gross × (1 − feePct/100). A credit is "matched" when the
// closest unused candidate is within tolerancePct; "partial" when one exists
// but the gap is larger; "missing" when the window closed with nothing;
// "pending" while the window is still open.

export const DEFAULT_SETTLEMENT = {
  mode: 'daily', lagDays: 1, windowDays: 4, feePct: 0, tolerancePct: 2, dayOfMonth: null,
  keywords: ['קארדקום', 'CARDCOM'], useCardIssuers: true,
};

export function shiftIso(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const nextMonth = (ym) => shiftIso(`${ym}-01`, 32).slice(0, 7);
const lastDay = (ym) => shiftIso(`${nextMonth(ym)}-01`, -1);
const r = (v) => Math.round(v);

// Does this bank row look like a settlement credit?
export function isSettlementCredit(row, keywords) {
  if (!(Number(row.amount) > 0)) return false;
  const hay = `${row.counterparty || ''} ${row.raw_desc || ''}`.toLowerCase();
  return keywords.some((k) => k && hay.includes(String(k).toLowerCase()));
}

function periodsFrom(sales, cfg) {
  if (cfg.mode === 'monthly') {
    const byMonth = new Map();
    for (const s of sales) {
      const ym = s.date.slice(0, 7);
      byMonth.set(ym, (byMonth.get(ym) || 0) + s.total);
    }
    return [...byMonth.entries()].sort().map(([ym, gross]) => {
      const nm = nextMonth(ym);
      let from = `${nm}-01`;
      let to = lastDay(nm);
      if (cfg.dayOfMonth) {
        const anchor = `${nm}-${String(cfg.dayOfMonth).padStart(2, '0')}`;
        from = shiftIso(anchor, -5);
        to = shiftIso(anchor, 5);
      }
      return { key: ym, label: ym, gross, from, to, multi: true };
    });
  }
  return sales
    .filter((s) => s.total > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((s) => ({
      key: s.date, label: s.date, gross: s.total,
      from: shiftIso(s.date, cfg.lagDays), to: shiftIso(s.date, cfg.lagDays + cfg.windowDays), multi: false,
    }));
}

export function reconcile({ sales, credits, settlement = {}, today }) {
  const cfg = { ...DEFAULT_SETTLEMENT, ...settlement };
  const feeMul = 1 - (Number(cfg.feePct) || 0) / 100;
  const tol = (Number(cfg.tolerancePct) || 0) / 100;
  const pool = credits.map((c) => ({ ...c, amount: Number(c.amount) || 0, used: false }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Two passes so a day whose own credit is missing cannot steal a
  // neighbour's: first every period takes a credit that fits within tolerance
  // (earliest in its window), only then do the leftovers pair up by amount.
  const periods = periodsFrom(sales, cfg).map((p) => ({ ...p, expected: r(p.gross * feeMul), matched: [] }));
  const within = (c, p) => !c.used && c.date >= p.from && c.date <= p.to;
  for (const p of periods) {
    if (p.multi) {
      p.matched = pool.filter((c) => within(c, p));
      for (const c of p.matched) c.used = true;
      continue;
    }
    const fit = pool.find((c) => within(c, p) && Math.abs(c.amount - p.expected) <= Math.max(1, p.expected * tol));
    if (fit) { fit.used = true; p.matched = [fit]; }
  }
  for (const p of periods) {
    if (p.multi || p.matched.length) continue;
    const cands = pool.filter((c) => within(c, p));
    if (!cands.length) continue;
    const best = cands.reduce((a, c) => (Math.abs(c.amount - p.expected) < Math.abs(a.amount - p.expected) ? c : a));
    best.used = true;
    p.matched = [best];
  }

  const rows = [];
  for (const p of periods) {
    const expected = p.expected;
    const matched = p.matched;
    const received = r(matched.reduce((a, c) => a + c.amount, 0));
    const diff = received - expected;
    let status;
    if (matched.length && Math.abs(diff) <= Math.max(1, expected * tol)) status = 'matched';
    else if (matched.length) status = 'partial';
    else if (p.to < today) status = 'missing';
    else status = 'pending';
    rows.push({
      key: p.key, label: p.label, gross: r(p.gross), expected, received, diff: r(diff), status,
      windowFrom: p.from, windowTo: p.to,
      credits: matched.map((c) => ({ id: c.id, date: c.date, amount: r(c.amount), desc: c.counterparty || c.raw_desc || '' })),
    });
  }
  const unmatchedCredits = pool.filter((c) => !c.used)
    .map((c) => ({ id: c.id, date: c.date, amount: r(c.amount), desc: c.counterparty || c.raw_desc || '' }));

  const summary = { matched: 0, partial: 0, missing: 0, pending: 0, missingAmount: 0, diffAmount: 0 };
  for (const row of rows) {
    summary[row.status] += 1;
    if (row.status === 'missing') summary.missingAmount += row.expected;
    if (row.status === 'partial') summary.diffAmount += row.diff;
  }
  return { mode: cfg.mode, rows: rows.reverse(), unmatchedCredits, summary };
}
