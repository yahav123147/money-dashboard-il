'use client';

import { useEffect, useState } from 'react';

// "איכות נתונים": the checks that protect the numbers on the other panels.
// One calm line when everything passes; otherwise the findings, worst first,
// each with the one thing to do about it.
const SEV = {
  fix: { label: 'לתקן', cls: 'stale' },
  warn: { label: 'לבדוק', cls: 'warn' },
  info: { label: 'לידיעה', cls: 'ok' },
};
const AREA = { cashflow: 'תזרים', tax: 'מסים', sales: 'מכירות', general: 'כללי' };

export default function Quality() {
  const [q, setQ] = useState(null);
  useEffect(() => {
    let on = true;
    const load = async () => {
      try { const res = await fetch('/api/quality', { cache: 'no-store' }); const j = await res.json(); if (on && !j.error) setQ(j); } catch { /* keep last */ }
    };
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { on = false; clearInterval(t); };
  }, []);
  const findings = q?.findings || [];
  const verdictText = !q ? '' : q.verdict === 'good' ? 'הנתונים נקיים' : q.verdict === 'check' ? 'יש מה לבדוק' : 'יש מה לתקן';
  return (
    <section className="panel" id="quality">
      <div className="panel-head">
        <h2>איכות נתונים</h2>
        <div className="side">{q ? <span className={`badge ${q.verdict === 'good' ? 'ok' : q.verdict === 'check' ? 'warn' : 'stale'}`}>{verdictText}</span> : null}</div>
      </div>
      {!q ? <p className="brief-loading">בודק…</p> : findings.length === 0 ? (
        <p className="q-clean">כל הבדיקות עברו: אין תשלומים קבועים כפולים, ימי המס תואמים לבנק, הסנכרון עדכני. {q.confidenceText}.</p>
      ) : (
        <ul className="q-list">
          {findings.map((f) => (
            <li className={`q-item sev-${f.severity}`} key={f.key}>
              <div className="q-top">
                <span className={`badge ${SEV[f.severity].cls}`}>{SEV[f.severity].label}</span>
                <span className="q-title">{f.title}</span>
                <span className="q-area">{AREA[f.area] || ''}</span>
              </div>
              <div className="q-text">{f.text}</div>
              {f.action ? <div className="q-action">{f.action}</div> : null}
            </li>
          ))}
        </ul>
      )}
      {q ? <p className="q-foot">נבדק {q.date.slice(8, 10)}.{q.date.slice(5, 7)} · {q.confidenceText}</p> : null}
    </section>
  );
}
