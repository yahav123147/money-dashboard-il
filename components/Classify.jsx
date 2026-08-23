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
  const pending = (d?.proposals || []).filter((p) => p.status === 'pending');
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
                <span className="cl-rule">חוק קבוע: "{p.match}" ← {p.bucket}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {d?.ts && pending.length ? <p className="q-foot">הצעות מ-{new Date(d.ts).toLocaleDateString('he-IL', { day: 'numeric', month: 'long' })} · אישור שומר חוק קבוע במסד ומסווג את התנועות של המוטב</p> : null}
    </section>
  );
}
