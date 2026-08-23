'use client';

import { useCallback, useEffect, useState } from 'react';
import { fmtIls } from './format';

// "סיווג": the classification agent's proposals, one row per counterparty,
// each with the category it suggests and why. Approve writes a permanent
// rule; reject just hides it. Nothing here runs AI; npm run classify does.
const CONF = { high: 'בטוח', medium: 'סביר', low: 'לא בטוח' };

export default function Classify() {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(async () => {
    try { const res = await fetch('/api/classify', { cache: 'no-store' }); const j = await res.json(); if (res.ok) setD(j); else setErr(j.error || 'שגיאה בטעינה'); } catch { /* keep */ }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 5 * 60 * 1000); return () => clearInterval(t); }, [load]);
  const act = async (action, p) => {
    setBusy(p.side + p.counterparty); setErr(null);
    try {
      const res = await fetch('/api/classify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, counterparty: p.counterparty, side: p.side }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) setErr(`"${p.counterparty}": ${j.error || 'האישור נכשל'}`);
      else if (j.warning) setErr(j.warning);
      await load();
    } catch (e) { setErr(`"${p.counterparty}": ${String(e?.message || e)}`); }
    finally { setBusy(null); }
  };
  const undo = async (r) => {
    setBusy('rule' + r.side + r.match); setErr(null);
    try {
      const res = await fetch('/api/classify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'undo', side: r.side, match: r.match }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) setErr(`ביטול "${r.match}": ${j.error || 'נכשל'}`);
      await load();
    } finally { setBusy(null); }
  };
  const rules = d?.rules || [];
  const pending = (d?.proposals || []).filter((p) => p.status === 'pending');
  const undone = (d?.proposals || []).filter((p) => p.status === 'undone');
  const [pick, setPick] = useState({});
  const BUCKETS = { out: ['suppliers_other', 'team', 'rent', 'tax_vat', 'tax_advance', 'tax_withholding', 'tax_social', 'pension', 'card_settlement', 'owner_draw', 'invest', 'loan_repayment', 'refund_direct'], in: ['direct', 'other_revenue', 'loan_in', 'owner_deposit', 'tax_refund'] };
  const approveWith = async (p, bucket) => {
    setBusy(p.side + p.counterparty); setErr(null);
    try {
      const res = await fetch('/api/classify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve', counterparty: p.counterparty, side: p.side, bucket }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) setErr(`"${p.counterparty}": ${j.error || 'האישור נכשל'}`);
      await load();
    } finally { setBusy(null); }
  };
  const done = (d?.proposals || []).filter((p) => p.status === 'approved');
  const now = d?.now;
  return (
    <section className="panel" id="classify">
      <div className="panel-head">
        <h2>סיווג</h2>
        <div className="side">{now ? <span className={`badge ${now.rows === 0 ? 'ok' : 'warn'}`}>{now.rows === 0 ? 'הכל מסווג' : `${now.rows} תנועות בלי קטגוריה · ${fmtIls(Math.abs(now.amount))}`}</span> : null}</div>
      </div>
      {err ? <p className="review-empty cl-err">{err}</p> : null}
      {d?.lastRun && !d.lastRun.ok ? <p className="review-empty cl-err">הריצה האחרונה של הסוכן ({new Date(d.lastRun.ts).toLocaleString('he-IL', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}) נכשלה: {d.lastRun.error}. ההצעות למטה הן מהריצה התקינה הקודמת.</p> : null}
      {!d ? <p className="brief-loading">טוען…</p> : now?.rows === 0 ? (
        <p className="q-clean">כל תנועות הבנק מסווגות. {done.length ? `${done.length} חוקים נכתבו מהצעות הסוכן.` : ''}</p>
      ) : pending.length === 0 ? (
        <p className="review-empty">
          {d.empty || !d.ok ? 'הסוכן עוד לא הציע סיווגים. ' : 'אין הצעות פתוחות. '}
          מריצים <code>npm run classify</code> (רץ על מנוי Claude שלך; בפעם הראשונה עם <code>-- --yes</code> לאישור שליחת תמצית הנתונים) או <code>/classify</code> בתוך Claude Code; ההצעות יופיעו כאן לאישור.
        </p>
      ) : (
        <ul className="cl-list">
          {pending.map((p) => (
            <li className="cl-item" key={p.side + p.counterparty}>
              <div className="cl-top">
                <span className="cl-name">{p.counterparty}</span>
                <span className="cl-meta">{p.count === 1 ? 'תנועה אחת' : `${p.count} תנועות`} · {fmtIls(Math.abs(p.total))}</span>
              </div>
              <div className="cl-prop">
                <span className="cl-bucket">{p.label}</span>
                <span className={`cl-conf conf-${p.confidence}`}>{CONF[p.confidence]}</span>
                {p.reason ? <span className="cl-reason">{p.reason}</span> : null}
              </div>
              <div className="cl-actions">
                <button className="mp-chip on" disabled={busy === p.side + p.counterparty} onClick={() => act('approve', p)}>אשר</button>
                <button className="mp-chip" disabled={busy === p.side + p.counterparty} onClick={() => act('reject', p)}>לא</button>
                <span className="cl-rule">חוק קבוע: כל מוטב שמכיל "{p.match}" ← {p.bucket}{p.alsoMatches?.total ? ` · יחול גם על ${p.alsoMatches.total === 1 ? 'מוטב נוסף' : `${p.alsoMatches.total} מוטבים נוספים`} (${p.alsoMatches.rows} תנועות): ${p.alsoMatches.names.map((a) => a.name).join(', ')}${p.alsoMatches.total > p.alsoMatches.names.length ? ` ועוד ${p.alsoMatches.total - p.alsoMatches.names.length}` : ''}` : ''}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {undone.length ? (
        <details className="cl-rules" open>
          <summary>{undone.length === 1 ? 'הצעה אחת שבוטלה' : `${undone.length} הצעות שבוטלו`}: לבחור קטגוריה אחרת, או להשאיר</summary>
          <ul className="cl-list">
            {undone.map((p) => (
              <li className="cl-item cl-rule-row" key={'u' + p.side + p.counterparty}>
                <span className="cl-name">{p.counterparty}</span>
                <span className="cl-meta">כרגע: {p.currentBucket || 'לא מסווג'}</span>
                <select className="ask-input cl-select" value={pick[p.side + p.counterparty] || p.bucket} onChange={(e) => setPick({ ...pick, [p.side + p.counterparty]: e.target.value })}>
                  {BUCKETS[p.side].map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
                <button className="mp-chip on" disabled={busy === p.side + p.counterparty} onClick={() => approveWith(p, pick[p.side + p.counterparty] || p.bucket)}>אשר</button>
                <button className="mp-chip" disabled={busy === p.side + p.counterparty} onClick={() => act('reject', p)}>להשאיר כך</button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {rules.length ? (
        <details className="cl-rules">
          <summary>{rules.length === 1 ? 'חוק קבוע אחד' : `${rules.length} חוקים קבועים`} מאישורים קודמים</summary>
          <ul className="cl-list">
            {rules.map((r) => (
              <li className="cl-item cl-rule-row" key={r.side + r.match}>
                <span className="cl-name">"{r.match}"</span>
                <span className="cl-bucket">{r.bucket}</span>
                <span className="cl-meta">{r.side === 'in' ? 'נכנס' : 'יוצא'} · {r.counterparty}</span>
                <button className="mp-chip" disabled={busy === 'rule' + r.side + r.match} onClick={() => undo(r)}>בטל</button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {d?.ts && pending.length ? <p className="q-foot">הצעות מ-{new Date(d.ts).toLocaleDateString('he-IL', { day: 'numeric', month: 'long' })} · אישור שומר חוק קבוע ומסווג מחדש את כל התנועות שתואמות לו, כמו שסנכרון היה עושה</p> : null}
    </section>
  );
}
