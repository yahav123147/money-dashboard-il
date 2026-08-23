'use client';

import { useState } from 'react';
import { fmtIls, fmtNum, hebMonth, EmptyState } from './format';

// The three buckets that never touch operating profit. Order is the display order
// of the closing band; it is also the lookup used to mark vendors in the table,
// because topVendors deliberately includes below-line spend (below-line spend).
const BELOW_ORDER = ['personal', 'charity', 'other_venture'];

// "of which: tax" — a subset of the categories listed below, never an extra line.
const TAX_IDS = ['tax_vat', 'tax_advance', 'tax_social', 'tax_withholding'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ---- the four groups the donut reads ----
// Colour follows the GROUP, never its rank: when the ordering changes month to
// month each group keeps its hue, so the eye can compare two months at a glance.
// The palette is validated for normal vision and for CVD on this paper surface —
// substituting a colour invalidates that, so these four are fixed.
// `ids: null` marks the catch-all: any category that is not team / tax / ads
// lands there, which means a category added later shows up instead of vanishing.
const GROUPS = [
  { id: 'team', name: 'צוות', color: '#B5791C', ids: ['team'] },
  { id: 'tax', name: 'מיסים', color: '#2F6FA8', ids: TAX_IDS },
  { id: 'ads', name: 'פרסום', color: '#1E8F6E', ids: ['ads'] },
  { id: 'rest', name: 'תפעול ושאר', color: '#9B4A7A', ids: null },
];
const NAMED = new Set(['team', 'ads', ...TAX_IDS]);

// Donut geometry. The viewBox is wider than it is tall on purpose: the two
// direct labels sit outside the ring and need the horizontal room.
const W = 300, H = 240, CX = 150, CY = 120;
const R = 78;       // radius of the ring's centre line
const RING = 24;    // ring thickness
const HIT = 36;     // transparent hit ring — comfortably past the 24px minimum
const GAP = 2;      // paper-coloured gap between segments (a gap, not a border)
const LR = 108;     // radius the direct labels sit at
const CIRC = 2 * Math.PI * R;

// Segments are drawn as dashes on a stroked circle: one dash per group, the rest
// of the circumference left blank. Cheaper and far less error-prone than arc
// path flags, and the gap falls out of the arithmetic instead of being faked.
function buildSegments(groups, arcTotal) {
  let acc = 0;
  return groups.map((g) => {
    const len = (Math.max(0, g.value) / arcTotal) * CIRC;
    const start = acc;
    acc += len;
    const mid = ((start + len / 2) / CIRC) * 2 * Math.PI; // 0 = twelve o'clock, clockwise
    return {
      ...g,
      start,
      len,
      // A segment shorter than the gap would otherwise invert into a negative dash.
      dash: Math.max(len - GAP, 0.5),
      offset: -(start + GAP / 2),
      lx: CX + Math.sin(mid) * LR,
      ly: CY - Math.cos(mid) * LR,
      tx: CX + Math.sin(mid) * (R + RING / 2 + 3),
      ty: CY - Math.cos(mid) * (R + RING / 2 + 3),
      ttx: CX + Math.sin(mid) * (LR - 7),
      tty: CY - Math.cos(mid) * (LR - 7),
      upper: Math.cos(mid) >= 0,
    };
  });
}

function GroupDonut({ byCategory, labels, total, pct }) {
  // One piece of state for hover and focus alike, so the keyboard path and the
  // mouse path can never drift apart. `keyed` only adds the focus marker.
  const [active, setActive] = useState(null);
  const [keyed, setKeyed] = useState(null);

  const groups = GROUPS.map((g) => {
    const ids = g.ids || Object.keys(byCategory).filter((id) => !NAMED.has(id));
    const parts = ids
      .map((id) => [id, num(byCategory[id])])
      .filter(([, v]) => v !== 0)
      .sort((a, b) => b[1] - a[1]);
    return { ...g, parts, value: parts.reduce((s, [, v]) => s + v, 0) };
  });

  // Ring order is by size; colour is not. Negative groups (a month of refunds)
  // are clamped out of the geometry rather than drawn as an impossible arc.
  const ordered = groups.slice().sort((a, b) => b.value - a.value);
  const arcTotal = ordered.reduce((s, g) => s + Math.max(0, g.value), 0);

  // Nothing to divide by — say so instead of emitting NaN into a path.
  if (!(arcTotal > 0)) return <EmptyState />;

  const segs = buildSegments(ordered, arcTotal);
  const labelled = segs.slice(0, 2).filter((s) => s.value > 0); // the two largest only
  const tip = segs.find((s) => s.id === active) || null;

  const describe = (g) =>
    `${g.name}: ${fmtIls(g.value)}, ${pct(g.value)}${
      g.parts.length
        ? ` — ${g.parts.map(([id, v]) => `${labels[id] || id} ${fmtIls(v)}`).join(', ')}`
        : ''
    }`;

  return (
    <div className="ex-split">
      <div className="ex-plot">
        {/* dir=ltr or the arc geometry mirrors under the page's RTL direction */}
        {/* The ring is the picture; the legend buttons below carry the semantics.
            Keyboard users reach every series through those real buttons, which
            drive this same active state, so focus shows exactly what hover shows.
            Deliberately not tabindex on the arcs: SVG shape focusability is not
            portable (Safari in particular), and a tab stop that lands on an
            invisible shape and announces nothing is worse than no stop at all. */}
        <div dir="ltr">
          <svg viewBox={`0 0 ${W} ${H}`} className="ex-donut" aria-hidden="true">
            {segs.map((g) => {
              const on = active === g.id;
              const off = active && !on;
              if (!(g.value > 0)) return null;
              return (
                <g key={g.id} className={`ex-arc${off ? ' off' : ''}`}>
                  <circle
                    cx={CX} cy={CY} r={R} fill="none"
                    stroke={g.color} strokeWidth={RING}
                    strokeDasharray={`${g.dash} ${CIRC - g.dash}`}
                    strokeDashoffset={g.offset}
                    transform={`rotate(-90 ${CX} ${CY})`}
                  />
                  {/* focus marker: a printed tick rule outside the focused segment */}
                  {keyed === g.id ? (
                    <circle
                      cx={CX} cy={CY} r={R + RING / 2 + 5} fill="none"
                      stroke="var(--ink)" strokeWidth="1.5"
                      strokeDasharray={`${(g.dash / CIRC) * (2 * Math.PI * (R + RING / 2 + 5))} ${
                        2 * Math.PI * (R + RING / 2 + 5)
                      }`}
                      strokeDashoffset={-((g.start + GAP / 2) / CIRC) * (2 * Math.PI * (R + RING / 2 + 5))}
                      transform={`rotate(-90 ${CX} ${CY})`}
                    />
                  ) : null}
                  {/* hit ring — wider than the paint, so the pointer target clears
                      the 24px minimum even on the thinnest slice */}
                  <circle
                    className="ex-hit"
                    cx={CX} cy={CY} r={R} fill="none"
                    stroke="rgba(0,0,0,0)" strokeWidth={HIT}
                    strokeDasharray={`${Math.max(g.len, 0.5)} ${CIRC - Math.max(g.len, 0.5)}`}
                    strokeDashoffset={-g.start}
                    transform={`rotate(-90 ${CX} ${CY})`}
                    pointerEvents="stroke"
                    onMouseEnter={() => setActive(g.id)}
                    onMouseLeave={() => setActive((c) => (c === g.id ? null : c))}
                  />
                </g>
              );
            })}

            {labelled.map((g) => {
              const right = g.lx > CX;
              return (
                <g key={`lab-${g.id}`} className={`ex-arc${active && active !== g.id ? ' off' : ''}`}>
                  <line x1={g.tx} y1={g.ty} x2={g.ttx} y2={g.tty} className="ex-lab-tick" />
                  <text
                    className="ex-lab"
                    x={right ? g.lx + 3 : g.lx - 3}
                    y={g.ly}
                    textAnchor={right ? 'start' : 'end'}
                    dominantBaseline="middle"
                  >
                    {pct(g.value)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Centre readout: body sans, proportional figures — this is a headline to
            read, not a column to align. dir=rtl because the shekel string carries
            RLM marks that would render wrong inside the LTR wrapper above. */}
        <div className="ex-center" dir="rtl">
          <div className="ex-center-fig">{fmtIls(total)}</div>
          <div className="ex-center-cap">סך הוצאות</div>
        </div>

        {tip ? (
          <div className={`ex-tip ${tip.upper ? 'is-bottom' : 'is-top'}`} dir="rtl" aria-hidden="true">
            <div className="ex-tip-head">
              <span className="ex-tip-sw" style={{ background: tip.color }} />
              {tip.name}
              <span className="ex-tip-pct num">{pct(tip.value)}</span>
              <b className="num">{fmtIls(tip.value)}</b>
            </div>
            {/* A group of one IS its category — listing it again under a head that
                already carries the same name and the same figure reads as a bug. */}
            {tip.parts.length > 1
              ? tip.parts.map(([id, v]) => (
                  <div className="ex-tip-row" key={id}>
                    <span>{labels[id] || id}</span>
                    <b className="num">{fmtIls(v)}</b>
                  </div>
                ))
              : null}
          </div>
        ) : null}
      </div>

      <div>
        <div className="ex-legend">
          {segs.map((g) => (
            <button
              type="button"
              key={g.id}
              className={`ex-leg${active === g.id ? ' on' : ''}${
                active && active !== g.id ? ' off' : ''
              }`}
              aria-label={describe(g)}
              onMouseEnter={() => setActive(g.id)}
              onMouseLeave={() => setActive((c) => (c === g.id ? null : c))}
              onFocus={(e) => {
                setActive(g.id);
                // the tick marker is a keyboard affordance — not wanted on a click
                if (e.target.matches(':focus-visible')) setKeyed(g.id);
              }}
              onBlur={() => { setActive(null); setKeyed(null); }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setActive(null); setKeyed(null); e.currentTarget.blur(); }
              }}
            >
              <span className="ex-leg-sw" style={{ background: g.color }} />
              <span className="ex-leg-name">{g.name}</span>
              <span className="ex-leg-amt num">{fmtIls(g.value)}</span>
              <span className="ex-leg-pct num">{pct(g.value)}</span>
            </button>
          ))}
        </div>
        <div className="ex-fine">
          כל קטגוריה שאינה צוות, מיסים או פרסום נכללת ב"תפעול ושאר". הפירוט המלא בטבלה שלמטה.
        </div>
      </div>
    </div>
  );
}

// Shell is shared by every empty path so the page grid never collapses.
function Shell({ children, side }) {
  return (
    <section className="panel full ex">
      <div className="panel-head">
        <h2>פילוח הוצאות</h2>
        {side ? <div className="side">{side}</div> : null}
      </div>
      {children}
    </section>
  );
}

export default function Expenses({ expenses, month }) {
  if (!expenses || !Array.isArray(expenses.months) || expenses.months.length === 0) {
    return (
      <Shell>
        <EmptyState />
      </Shell>
    );
  }

  const months = expenses.months.filter(Boolean);
  const labels = expenses.labels && typeof expenses.labels === 'object' ? expenses.labels : {};

  // The picker is the source of truth; fall back to the newest month we have.
  const current = (month && months.find((m) => m.month === month))
    || months[months.length - 1];

  if (!current) {
    return (
      <Shell>
        <EmptyState />
      </Shell>
    );
  }

  const byCategory =
    current.byCategory && typeof current.byCategory === 'object' ? current.byCategory : {};
  const cats = Object.entries(byCategory)
    .map(([id, v]) => [id, num(v)])
    .filter(([, v]) => v !== 0)
    .sort((a, b) => b[1] - a[1]);

  const max = cats.length ? cats[0][1] : 0;
  const total = num(current.total);
  const lead = cats.length ? cats[0] : null;
  const taxTotal = TAX_IDS.reduce((s, id) => s + num(byCategory[id]), 0);

  const vendors = (Array.isArray(current.topVendors) ? current.topVendors : [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => num(b.amount) - num(a.amount));
  const hasOob = vendors.some((v) => BELOW_ORDER.includes(v.category));

  const belowLine = current.belowLine && typeof current.belowLine === 'object' ? current.belowLine : {};
  const belowTotal = num(current.belowLineTotal);

  // Share of the month's operating total. Sub-percent lines read as "<1%" rather
  // than a rounded 0% — a rounded zero next to a real number looks like a bug.
  const pctText = (v) => {
    if (!(total > 0)) return '—';
    const p = (v / total) * 100;
    if (p > 0 && p < 1) return '<1%';
    return `${Math.round(p)}%`;
  };

  return (
    <Shell
      side={
        cats.length ? <span className="tag">{fmtNum(cats.length)} קטגוריות</span> : null
      }
    >
      {cats.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {/* ---- summary band: the answer in three cells ---- */}
          <div className="ex-summary">
            <div className="ex-sum-cell">
              <div className="ex-kicker">סך הוצאות · {hebMonth(current.month)}</div>
              <div className="ex-figure">
                <span className="num">{fmtIls(total)}</span>
                {current.partial ? <span className="tag">חלקי</span> : null}
              </div>
            </div>

            <div className="ex-sum-cell">
              <div className="ex-kicker">הקטגוריה המובילה</div>
              <div className="ex-lead-name">
                {labels[lead[0]] || lead[0]}
                <span className="ex-lead-pct num">{pctText(lead[1])}</span>
              </div>
              <div className="ex-sub">
                <span className="num">{fmtIls(lead[1])}</span>
              </div>
            </div>

            <div className="ex-sum-cell">
              <div className="ex-kicker">מתוכו מיסים</div>
              <div className="ex-lead-name ex-tax">
                <span className="num">{taxTotal ? fmtIls(taxTotal) : '—'}</span>
                {taxTotal ? <span className="ex-lead-pct num">{pctText(taxTotal)}</span> : null}
              </div>
              <div className="ex-sub">מע"מ · מקדמות · ביטוח לאומי · ניכויים</div>
            </div>
          </div>

          {/* ---- the proportion: four groups on a ring. The schedule below is the
                   precision — every figure readable there without hovering anything. ---- */}
          <div className="ex-groups">
            <div className="ex-sec-title">פילוח לארבע קבוצות</div>
            <GroupDonut byCategory={byCategory} labels={labels} total={total} pct={pctText} />
          </div>

          {/* ---- the schedule: one ruled line per category, bar length = share ---- */}
          <div className="ex-cats">
            {cats.map(([id, v], i) => {
              // Linear, never logarithmic: the point of this schedule is that the
              // leader dwarfs the rest. min-width in CSS keeps sub-percent lines visible.
              const share = max > 0 ? v / max : 0;
              const w = (share * 100).toFixed(2);
              const alpha = (0.3 + 0.7 * share).toFixed(3);
              return (
                <div className={`ex-cat${i === 0 ? ' ex-cat-lead' : ''}`} key={id}>
                  <span className="ex-cat-name">{labels[id] || id}</span>
                  <span className="ex-track">
                    <span
                      className="ex-fill"
                      style={{ width: `${w}%`, background: `rgba(138, 106, 37, ${alpha})` }}
                    />
                  </span>
                  <span className="ex-amt num">{fmtIls(v)}</span>
                  <span className="ex-pct num">{pctText(v)}</span>
                </div>
              );
            })}
          </div>

          {/* ---- top vendors ---- */}
          {vendors.length ? (
            <div className="ex-sec">
              <div className="ex-sec-title">הספקים הגדולים</div>
              <div className="table-wrap">
                <table className="ex-table">
                  <thead>
                    <tr>
                      <th>שם ספק</th>
                      <th>קטגוריה</th>
                      <th className="num">₪</th>
                      <th className="num">תנועות</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendors.map((v, i) => {
                      const oob = BELOW_ORDER.includes(v.category);
                      return (
                        <tr key={`${v.name}-${i}`} className={oob ? 'ex-oob-row' : undefined}>
                          {/* dir=auto so latin descriptors and Hebrew names each get their own base direction */}
                          <td className="strong" dir="auto">
                            {v.name}
                          </td>
                          <td className="ex-cat-cell">
                            {labels[v.category] || v.category || '—'}
                            {oob ? <span className="tag ex-oob">מחוץ לרווח</span> : null}
                          </td>
                          <td className="num">{fmtIls(num(v.amount))}</td>
                          <td className="num">{fmtNum(num(v.count))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {hasOob ? (
                <div className="ex-fine">
                  הרשימה מדורגת לפי סכום וכוללת גם שורות שאינן תפעוליות — הן מסומנות
                  "מחוץ לרווח" ואינן נכללות בסך ההוצאות שלמעלה.
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {/* ---- closing band: money that never touches operating profit ---- */}
      {belowTotal > 0 ? (
        <div className="ex-below">
          <div className="ex-below-main">
            הוצאות שאינן תפעוליות: <b className="num">{fmtIls(belowTotal)}</b> — מחוץ לרווח
          </div>
          <div className="ex-below-items">
            {BELOW_ORDER.map((id) => {
              const v = num(belowLine[id]);
              return (
                <span className="ex-below-item" key={id}>
                  {labels[id] || id}
                  <b className="num">{v > 0 ? fmtIls(v) : '—'}</b>
                </span>
              );
            })}
          </div>
          <div className="ex-below-note">
            הסכום הזה יורד מהחשבון אך אינו נספר בהוצאות העסק ואינו מקטין את הרווח התפעולי.
          </div>
        </div>
      ) : null}
    </Shell>
  );
}
