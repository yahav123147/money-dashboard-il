'use client';

import { useEffect, useState } from 'react';
import { fmtIls, fmtNum, hebMonth, EmptyState } from './format';

// Revenue split by the business's own channels. Follows the month picker;
// the YTD column is always there for the year view. Anything not yet matched
// to a channel can be assigned right here: that writes a rule to
// config/channels.json and the next fetch re-attributes history.
export default function Channels({ channels: initial, month }) {
  const [data, setData] = useState(null);
  const [newChannel, setNewChannel] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [showUnmatched, setShowUnmatched] = useState(false);

  const load = async () => {
    try { const res = await fetch('/api/channels', { cache: 'no-store' }); if (res.ok) setData(await res.json()); } catch { /* keep */ }
  };
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);

  const d = data || initial;
  if (!d) {
    return <section className="panel full"><div className="panel-head"><h2>מחזור לפי ערוץ</h2></div><EmptyState /></section>;
  }

  async function post(body) {
    setErr('');
    try {
      const res = await fetch('/api/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'שגיאה');
      await load();
    } catch (e) { setErr(String(e.message || e)); }
  }
  async function addChannel(e) {
    e.preventDefault();
    const name = newChannel.trim();
    if (!name) return;
    await post({ action: 'setChannels', channels: [...(d.channels || []), name] });
    setNewChannel('');
  }
  async function assign(u, channel) {
    if (!channel) return;
    setBusy(`${u.kind}|${u.name}`);
    const kind = u.kind === 'bank' ? 'bank' : (u.name && u.name !== 'אחר' ? 'product' : 'amount');
    await post({ action: 'assign', kind, match: u.name, amount: u.sampleAmount, channel });
    setBusy('');
  }

  const monthEntry = (d.months || []).find((m) => m.month === month) || null;
  const view = monthEntry || d.ytd;
  const label = monthEntry ? hebMonth(month) : 'מתחילת שנת המס';
  const allChannels = [...(d.channels || [])];
  if (view.byChannel?.[d.unmatchedLabel]) allChannels.push(d.unmatchedLabel);
  const allRows = allChannels
    .map((c) => ({ name: c, ...(view.byChannel?.[c] || { amount: 0, count: 0 }) }))
    .sort((a, b) => b.amount - a.amount);
  const rows = allRows.filter((x) => x.amount !== 0);
  const zero = allRows.filter((x) => x.amount === 0 && x.name !== d.unmatchedLabel);
  const total = view.total || 0;
  const max = Math.max(1, ...rows.map((x) => x.amount));
  const ytdTotal = d.ytd?.total || 0;
  const unmatched = Array.isArray(d.unmatched) ? d.unmatched : [];

  return (
    <section className="panel full">
      <div className="panel-head">
        <h2>מחזור לפי ערוץ · {label}</h2>
        <div className="side"><span className="badge">{fmtIls(total)}</span></div>
      </div>

      {d.channels.length === 0 ? (
        <p className="su-intro">עדיין לא הוגדרו ערוצים. הוסף את ערוצי ההכנסה של העסק (למשל: ליווי, קורס, מוצר, ייעוץ) ואז שייך אליהם מוצרים ומוטבים.</p>
      ) : null}

      {rows.length > 0 ? (
        <div className="ch-cards">
          {rows.map((x, i) => {
            const pct = total > 0 ? Math.round((x.amount / total) * 100) : 0;
            const ytdC = d.ytd?.byChannel?.[x.name] || { amount: 0, count: 0 };
            const ytdPct = ytdTotal > 0 ? Math.round((ytdC.amount / ytdTotal) * 100) : 0;
            const isUnm = x.name === d.unmatchedLabel;
            const isLead = i === 0 && x.amount > 0 && !isUnm;
            return (
              <article className={`ch-card${isLead ? ' ch-lead' : ''}${isUnm ? ' ch-unm' : ''}`} key={x.name}>
                <div className="ch-card-name">{x.name}</div>
                <div className="ch-card-hero">
                  <span className="k">{monthEntry ? hebMonth(month) : 'מתחילת השנה'}</span>
                  <span className="v num">{fmtIls(x.amount)}</span>
                </div>
                {monthEntry ? (
                  <div className="ch-card-line"><span className="k">מתחילת השנה</span><span className="v num">{fmtIls(ytdC.amount)} <span className="ch-cnt">{ytdPct}%</span></span></div>
                ) : null}
                <div className="ch-card-line"><span className="k">עסקאות</span><span className="v num">{fmtNum(x.count)}{monthEntry ? <span className="ch-cnt"> · {fmtNum(ytdC.count)} בשנה</span> : null}</span></div>
                <div className="ch-card-share">
                  <div className="ch-share"><div className="ch-share-fill" style={{ width: `${pct}%` }} /></div>
                  <span className="ch-share-num num">{pct}%</span>
                </div>
              </article>
            );
          })}
        </div>
      ) : d.channels.length > 0 ? <EmptyState text="אין הכנסות בתקופה" /> : null}
      {zero.length > 0 ? <p className="su-hint" style={{ marginTop: 8 }}>{zero.length === 1 ? 'ערוץ אחד' : `${zero.length} ערוצים`} ללא הכנסה בתקופה: {zero.map((z) => z.name).join(' · ')}</p> : null}

      <form onSubmit={addChannel} className="su-actions" style={{ marginTop: 14 }}>
        <input className="su-input" style={{ direction: 'rtl', textAlign: 'right', minWidth: 200 }} placeholder="ערוץ חדש, למשל: ליווי עסקי" value={newChannel} onChange={(e) => setNewChannel(e.target.value)} />
        <button type="submit" className="mp-chip" disabled={!newChannel.trim()}>הוסף ערוץ</button>
        {unmatched.length > 0 ? (
          <button type="button" className="mp-chip" onClick={() => setShowUnmatched((v) => !v)}>
            {showUnmatched ? 'הסתר' : `לשיוך (${unmatched.length})`}
          </button>
        ) : null}
      </form>
      {err ? <div className="su-err">{err}</div> : null}

      {showUnmatched && unmatched.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <p className="su-hint">הכנסות שלא שויכו לערוץ. בחירת ערוץ שומרת כלל: כל מה שמכיל את הטקסט הזה ישויך מעכשיו, כולל היסטוריה.</p>
          {unmatched.map((u) => (
            <div className="kv" key={`${u.kind}|${u.name}`}>
              <span className="k" title={u.name}>
                <span className="badge" style={{ marginInlineEnd: 6 }}>{u.kind === 'bank' ? 'בנק' : 'קארדקום'}</span>
                {u.name.length > 34 ? `${u.name.slice(0, 34)}…` : u.name}
                {' '}<span style={{ opacity: 0.55 }}>×{fmtNum(u.count)} · {fmtIls(u.amount)}</span>
              </span>
              <select className="su-input" style={{ padding: '4px 8px', direction: 'rtl' }} disabled={busy === `${u.kind}|${u.name}` || d.channels.length === 0} defaultValue="" onChange={(e) => assign(u, e.target.value)}>
                <option value="">שייך לערוץ…</option>
                {d.channels.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
