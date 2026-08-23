'use client';

import { useEffect, useState } from 'react';
import { fmtIls, hebDay, EmptyState } from './format';

// CardCom ↔ bank: one row per settlement period, a verdict each. Hidden when
// the CardCom module is off. The question this panel answers is "did the
// money I cleared actually land?", so missing rows come first.
const STATUS = {
  missing: { label: 'חסר בבנק', cls: 'rc-miss' },
  partial: { label: 'סכום שונה', cls: 'rc-part' },
  pending: { label: 'בדרך', cls: 'rc-pend' },
  matched: { label: 'הגיע', cls: 'rc-ok' },
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
  let sub;
  if (s.missing > 0) {
    headline = <span className="rc-miss">{fmtIls(s.missingAmount)} חסרים בבנק</span>;
    sub = `כסף שנסלק בקארדקום ולא הגיע לחשבון הבנק בזמן (${s.missing} ${s.missing === 1 ? 'יום מכירות' : 'ימי מכירות'})`;
  } else if (s.partial > 0) {
    headline = <span className="rc-part">פער של {fmtIls(Math.abs(s.diffAmount))}</span>;
    sub = `הזיכוי הגיע לבנק, אבל בסכום שונה מהצפוי (${s.partial} ${s.partial === 1 ? 'יום' : 'ימים'})`;
  } else {
    headline = <span className="rc-ok">הכל הגיע לבנק</span>;
    sub = 'כל מה שנסלק בקארדקום נמצא בחשבון הבנק';
  }
  const counts = [
    s.matched ? `${s.matched} הגיעו` : null,
    s.pending ? `${s.pending} בדרך` : null,
    s.partial ? `${s.partial} עם פער` : null,
    s.missing ? `${s.missing} חסרים` : null,
  ].filter(Boolean).join(' · ');

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>התאמת סליקה ↔ בנק</h2>
        <div className="side"><span className="badge">{data.days} יום</span></div>
      </div>
      <div className="hero-secondary">{headline}</div>
      <div className="hero-sub">{sub}</div>
      <div className="su-hint" style={{ marginTop: 6 }}>{counts}. הבדיקה: לכל יום מכירות, האם נכנס לבנק זיכוי סליקה בסכום המתאים תוך {data.windowDays ?? 'כמה'} ימים.</div>

      {rows.length === 0 ? <EmptyState text="אין מכירות בתקופה" /> : (
        <div style={{ marginTop: 14 }}>
          {shown.length === 0 ? <div className="su-hint">אין בעיות פתוחות. {rows.length} תקופות, כולן נחתו או עדיין בחלון.</div> : null}
          {shown.map((row) => {
            const st = STATUS[row.status] || STATUS.pending;
            return (
              <div className="kv" key={row.key} title={row.credits.map((c) => `${c.date} ${c.desc} ${c.amount}`).join('\n')} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span className="k">
                    <span className={`rc-dot ${st.cls}`} /> {data.mode === 'monthly' ? 'מכירות חודש' : 'מכירות'} {fmtLabel(row)}: נסלקו {fmtIls(row.gross)}
                  </span>
                  <span className={`v num ${st.cls}`}>{st.label}</span>
                </div>
                <div className="su-hint" style={{ margin: 0 }}>
                  {row.status === 'matched' ? `נכנסו לבנק ${fmtIls(row.received)} ב${hebDay(row.credits[0]?.date)}`
                    : row.status === 'pending' ? `צפוי להיכנס לבנק ${fmtIls(row.expected)} עד ${hebDay(row.windowTo)}`
                    : row.status === 'partial' ? `צפוי ${fmtIls(row.expected)}, נכנסו ${fmtIls(row.received)} (${row.diff > 0 ? '+' : ''}${fmtIls(row.diff)})`
                    : `צפוי ${fmtIls(row.expected)} עד ${hebDay(row.windowTo)}, לא נמצא זיכוי בבנק. לבדוק מול חברת הסליקה`}
                </div>
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
              נכנסו לבנק זיכויי סליקה שלא מתאימים לאף יום מכירות: {data.unmatchedCredits.slice(0, 3).map((c) => `${hebDay(c.date)} ${fmtIls(c.amount)}`).join(' · ')}
              {data.unmatchedCredits.length > 3 ? ` ועוד ${data.unmatchedCredits.length - 3}` : ''}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
