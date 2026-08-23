'use client';

import { useEffect, useState } from 'react';
import { fmtIls, hebDay, EmptyState } from './format';

// CardCom ↔ bank: one row per settlement period, a verdict each. Hidden when
// the CardCom module is off. The question this panel answers is "did the
// money I cleared actually land?", so missing rows come first.
const STATUS = {
  missing: { label: 'לא נחת', cls: 'rc-miss' },
  partial: { label: 'פער', cls: 'rc-part' },
  pending: { label: 'ממתין', cls: 'rc-pend' },
  matched: { label: 'נחת', cls: 'rc-ok' },
};
const ORDER = { missing: 0, partial: 1, pending: 2, matched: 3 };

export default function Reconcile() {
  const [data, setData] = useState(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/reconcile?days=45', { cache: 'no-store' });
        const json = res.ok ? await res.json() : null;
        if (!cancelled) setData(json);
      } catch { if (!cancelled) setData(null); }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!data || data.enabled === false) return null;
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const s = data.summary || {};
  const problems = rows.filter((x) => x.status === 'missing' || x.status === 'partial');
  const shown = showAll ? [...rows].sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || b.label.localeCompare(a.label)) : problems;
  const fmtLabel = (row) => (data.mode === 'monthly' ? row.label : hebDay(row.label));

  let headline;
  if (s.missing > 0) headline = <span className="rc-miss">{fmtIls(s.missingAmount)} לא נחתו</span>;
  else if (s.partial > 0) headline = <span className="rc-part">פער של {fmtIls(Math.abs(s.diffAmount))}</span>;
  else headline = <span className="rc-ok">הכל נחת</span>;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>התאמת סליקה ↔ בנק</h2>
        <div className="side"><span className="badge">{data.days} יום</span></div>
      </div>
      <div className="hero-secondary">{headline}</div>
      <div className="hero-sub">
        {s.matched || 0} נחתו · {s.pending || 0} ממתינים{s.partial ? ` · ${s.partial} עם פער` : ''}{s.missing ? ` · ${s.missing} לא נחתו` : ''}
      </div>

      {rows.length === 0 ? <EmptyState text="אין מכירות בתקופה" /> : (
        <div style={{ marginTop: 14 }}>
          {shown.length === 0 ? <div className="su-hint">אין בעיות פתוחות. {rows.length} תקופות, כולן נחתו או עדיין בחלון.</div> : null}
          {shown.map((row) => {
            const st = STATUS[row.status] || STATUS.pending;
            return (
              <div className="kv" key={row.key} title={row.credits.map((c) => `${c.date} ${c.desc} ${c.amount}`).join('\n')}>
                <span className="k">
                  <span className={`rc-dot ${st.cls}`} /> {fmtLabel(row)}
                  {' '}<span style={{ opacity: 0.55 }}>צפוי {fmtIls(row.expected)}</span>
                </span>
                <span className={`v num ${st.cls}`}>
                  {row.status === 'matched' ? st.label
                    : row.status === 'pending' ? `${st.label} עד ${hebDay(row.windowTo)}`
                    : row.status === 'partial' ? `${row.diff > 0 ? '+' : ''}${fmtIls(row.diff)}`
                    : st.label}
                </span>
              </div>
            );
          })}
          {rows.length > problems.length ? (
            <button type="button" className="mp-chip" style={{ marginTop: 10 }} onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'רק בעיות' : `הצג הכל (${rows.length})`}
            </button>
          ) : null}
          {Array.isArray(data.unmatchedCredits) && data.unmatchedCredits.length > 0 ? (
            <div className="su-hint" style={{ marginTop: 10 }}>
              זיכויי סליקה בבנק שלא שויכו למכירות: {data.unmatchedCredits.slice(0, 3).map((c) => `${hebDay(c.date)} ${fmtIls(c.amount)}`).join(' · ')}
              {data.unmatchedCredits.length > 3 ? ` ועוד ${data.unmatchedCredits.length - 3}` : ''}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
