'use client';

import { useEffect, useRef, useState } from 'react';

// "שאל את הנתונים": a small chat over the business's own numbers. Every
// question is one call to /api/ask, which runs through the same consent +
// subscription gate as the other agents. Nothing here talks to any AI
// directly. History is kept only in this tab.
const SUGGESTIONS = ['כמה כסף נכנס לבנק בחודש שעבר?', 'על מה יצא הכי הרבה כסף החודש?', 'מי הלקוחות הגדולים בשלושת החודשים האחרונים?', 'כמה שילמתי מע"מ השנה?'];

export default function Ask() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { if (open) endRef.current?.scrollIntoView({ block: 'nearest' }); }, [msgs, busy, open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const ask = async (question) => {
    const text = String(question || q).trim();
    if (!text || busy) return;
    setQ('');
    const history = msgs.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.text }));
    setMsgs((m) => [...m, { role: 'user', text }]);
    setBusy(true);
    try {
      const res = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: text, history }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) setMsgs((m) => [...m, { role: 'assistant', text: j.error || 'לא הצלחתי לענות', error: true }]);
      else setMsgs((m) => [...m, { role: 'assistant', text: j.answer, sql: j.sql, rows: j.rows }]);
    } catch (e) { setMsgs((m) => [...m, { role: 'assistant', text: String(e?.message || e), error: true }]); }
    finally { setBusy(false); }
  };

  return (
    <>
      <button type="button" className={`ask-fab${open ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="ask-drawer" title="שאל את הנתונים">
        <span className="ask-fab-icon" aria-hidden="true">{open ? '×' : '?'}</span>
        <span className="ask-fab-label">{open ? 'סגור' : 'שאל את הנתונים'}</span>
      </button>
      <aside id="ask-drawer" className={`ask-drawer${open ? ' open' : ''}`} aria-hidden={!open} aria-label="שאל את הנתונים">
        <div className="ask-head">
          <div>
            <div className="ask-title">שאל את הנתונים</div>
            <div className="ask-note">רץ על מנוי Claude שלך · כל שאלה כ-10 שניות</div>
          </div>
          {msgs.length ? <button type="button" className="linkish" onClick={() => setMsgs([])} disabled={busy}>שיחה חדשה</button> : null}
        </div>
        <div className="ask-body">
          {msgs.length === 0 ? (
            <div className="ask-sugg">
              <p className="ask-hint">שאלה על הכסף של העסק, בעברית. לדוגמה:</p>
              {SUGGESTIONS.map((s) => <button key={s} className="mp-chip" onClick={() => ask(s)}>{s}</button>)}
            </div>
          ) : (
            <div className="ask-log">
              {msgs.map((m, i) => (
                <div className={`ask-msg ${m.role}${m.error ? ' err' : ''}`} key={i}>
                  <div className="ask-text">{m.text}</div>
                  {m.sql ? <details className="ask-sql"><summary>איך חישבתי</summary><pre>{m.sql}</pre>{m.rows?.length ? <pre>{JSON.stringify(m.rows.slice(0, 10), null, 1)}</pre> : null}</details> : null}
                </div>
              ))}
              {busy ? <div className="ask-msg assistant"><div className="ask-text ask-busy">בודק בנתונים…</div></div> : null}
              <div ref={endRef} />
            </div>
          )}
        </div>
        <form className="ask-form" onSubmit={(e) => { e.preventDefault(); ask(); }}>
          <input className="ask-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="למשל: כמה שילמתי לספקים באוגוסט?" disabled={busy} aria-label="שאלה על הנתונים" autoFocus={open} />
          <button className="mp-chip on" type="submit" disabled={busy || !q.trim()}>שאל</button>
        </form>
      </aside>
    </>
  );
}
