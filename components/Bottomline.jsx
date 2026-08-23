// Bottomline — the top line of the statement. Three cells answering the owner's
// standing questions at a glance: monthly revenue, operating profit, advances gap. Consumes props page.jsx already holds — zero new fetches.
// Each cell guards its own source and prints '···' when that source is null,
// so the strip never crashes even when every prop is null.

import { fmtIls, hebMonth, Badge } from './format';

const last = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null);
const totalCollected = (m) => (m ? Object.values(m.collected).reduce((a, b) => a + b, 0) : 0);
const monthNamed = (arr, ym) => (Array.isArray(arr) ? arr.find((m) => m.month === ym) || null : null);

export default function Bottomline({ pnl, advances, month }) {
  // Headline = the last COMPLETE month. Mid-month the current month always reads
  // badly (fixed costs leave early in the month, receipts arrive later), so a
  // partial figure as the headline misinforms. The partial month
  // still gets a sub-line — it is context, not the verdict.
  const months = Array.isArray(pnl?.months) ? pnl.months : [];
  const complete = months.filter((m) => !m.partial);
  const newestComplete = complete.length ? complete[complete.length - 1] : null;
  // The picker wins when it names a month we have; otherwise fall back to the
  // long-standing rule — the last COMPLETE month, never a partial one.
  const picked = month ? months.find((m) => m.month === month) : null;
  const full = picked || newestComplete || last(months);
  // The partial-month sub-line ("X so far") only makes sense when the headline
  // itself is the newest complete month — the default view, or picking that
  // same month explicitly. Any earlier month has nothing to do with "so far",
  // and picking the partial month itself makes IT the headline, not a footnote.
  const cur = (full && newestComplete && full.month === newestComplete.month)
    ? (months.find((m) => m.partial) || null)
    : null;
  const showCur = cur && full && cur.month !== full.month ? cur : null;

  // pnl.avg3m
  // is fixed server-side to the three newest complete months in the whole
  // dataset, so it silently keeps describing (say) May-Jul while the headline
  // above it is showing March. Recompute it client-side, scoped to the three
  // complete months ending at the headline month, from the same pnl.months
  // array — never pnl.avg3m itself (PnlTable still reads that field). Only
  // rendered when all three exist, so the "3 חודשים" label is never wrong.
  const avg3mMonths = full ? months.filter((m) => !m.partial && m.month <= full.month).slice(-3) : [];
  const avg3mScoped = avg3mMonths.length === 3
    ? Math.round(avg3mMonths.reduce((s, m) => s + m.operating_profit, 0) / 3)
    : null;
  const req = advances?.requiredRatePct;
  const gap = advances?.annualGapIls;
  const gapBad = req != null && advances?.ratePct != null && req - advances.ratePct >= 0.5;

  const profit = full?.operating_profit;
  const profitNeg = Number.isFinite(profit) && profit < 0;
  const monthTag = full ? `${hebMonth(full.month)}${full.partial ? ' (חלקי)' : ''}` : '';

  // advances tone: red when under-paying by ≥0.5pp, teal when the gap is a surplus (<0)
  const advCls = gapBad ? 'neg' : (gap != null && gap < 0 ? 'pos' : '');

  return (
    <section className="bl panel full" aria-label="שורה תחתונה">
      <div className="bl-grid">

        {/* 1 — מחזור החודש */}
        <div className="bl-cell">
          <div className="bl-kicker">מחזור חודשי</div>
          {full ? (
            <div className="bl-figure num" dir="ltr">
              {fmtIls(full.revenue_gross)}
              <Badge tone="">{monthTag}</Badge>
            </div>
          ) : (
            <div className="bl-figure bl-empty">···</div>
          )}
          <div className="bl-subs">
            {showCur ? (
              <div className="bl-sub">
                {hebMonth(showCur.month)} עד כה:{' '}
                <span className="num" dir="ltr">{fmtIls(showCur.revenue_gross)}</span>
              </div>
            ) : null}
          </div>
        </div>

        {/* 2 — רווח תפעולי */}
        <div className="bl-cell">
          <div className="bl-kicker">רווח תפעולי</div>
          {full ? (
            <div className={`bl-figure num${profitNeg ? ' neg' : ''}`} dir="ltr">
              {fmtIls(profit)}
              <Badge tone="">{monthTag}</Badge>
            </div>
          ) : (
            <div className="bl-figure bl-empty">···</div>
          )}
          <div className="bl-subs">
            {showCur ? (
              <div className="bl-sub">
                {hebMonth(showCur.month)} עד כה:{' '}
                <span className={`num${showCur.operating_profit < 0 ? ' neg' : ''}`} dir="ltr">
                  {fmtIls(showCur.operating_profit)}
                </span>
              </div>
            ) : null}
            {avg3mScoped != null ? (
              <div className="bl-sub">
                ממוצע 3 חודשים: <span className="num" dir="ltr">{fmtIls(avg3mScoped)}</span>
              </div>
            ) : null}
          </div>
        </div>

        {/* 3 — מקדמות */}
        <div className="bl-cell">
          <div className="bl-kicker">מקדמות מס</div>
          {advances ? (
            <div className="bl-figure">
              משולם <span className="num">{advances.ratePct}%</span>
            </div>
          ) : (
            <div className="bl-figure bl-empty">···</div>
          )}
          <div className="bl-subs">
            {advances ? (
              req != null ? (
                <div className={`bl-sub bl-adv ${advCls}`.trim()}>
                  נדרש <span className="num" dir="ltr">{req}%</span>
                  {' · '}
                  פער <span className="num" dir="ltr">{fmtIls(gap)}</span> לשנה
                </div>
              ) : (
                <div className="bl-sub bl-empty">נדרש ···</div>
              )
            ) : null}
          </div>
        </div>

      </div>
    </section>
  );
}
