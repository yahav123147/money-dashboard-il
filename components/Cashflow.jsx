'use client';

import { useEffect, useState } from 'react';
import { fmtIls, hebDay, EmptyState } from './format';

// Forward cashflow. Horizon 30/60/90; movements come from future-dated bank
// rows, manual recurring.json items, recurring items learned from history,
// and CardCom settlements still inside their window. The headline is a
// sentence: where the balance bottoms out and what lifts it back.
const HORIZONS = [30, 60, 90];

export default function Cashflow({ cashflow: initial }) {
  const [horizon, setHorizon] = useState(30);
  const [data, setData] = useState(null);
  const [showLearned, setShowLearned] = useState(false);
  const [busy, setBusy] = useState('');

  const load = async (h) => {
    try {
      const res = await fetch(`/api/cashflow?days=${h}`, { cache: 'no-store' });
      if (res.ok) setData(await res.json());
    } catch { /* keep last */ }
  };
  useEffect(() => { load(horizon); const t = setInterval(() => load(horizon), 60_000); return () => clearInterval(t); }, [horizon]);

  const cf = data || initial;
  if (!cf || !Array.isArray(cf.days)) {
    return (
      <section className="panel">
        <div className="panel-head"><h2>תזרים קדימה</h2></div>
        <EmptyState />
      </section>
    );
  }

  async function act(action, item) {
    setBusy(item.name);
    try {
      await fetch('/api/recurring', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, item }) });
      await load(horizon);
    } finally { setBusy(''); }
  }

  const days = cf.days;
  const eventDays = days.filter((d) => Array.isArray(d.items) && d.items.length > 0);
  const dip = cf.dip;
  const learned = Array.isArray(cf.learned) ? cf.learned : [];
  const monthlyNet = learned.reduce((a, it) => a + it.amount, 0) + (cf.manual || []).reduce((a, it) => a + it.amount, 0);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>תזרים {cf.horizon} יום קדימה</h2>
        <div className="side">
          {HORIZONS.map((h) => (
            <button type="button" key={h} className={`mp-chip${horizon === h ? ' on' : ''}`} aria-pressed={horizon === h} onClick={() => setHorizon(h)}>{h}</button>
          ))}
        </div>
      </div>

      <div className="kv">
        <span className="k">יתרת עו"ש נוכחית</span>
        <span className="v num">{fmtIls(cf.startBalance)}</span>
      </div>
      <div className="kv">
        <span className="k">צפי לעוד {cf.horizon} יום</span>
        <span className={`v num${Number(cf.endProjected) < 0 ? ' neg' : ''}`}>{fmtIls(cf.endProjected)}</span>
      </div>
      <div className="kv">
        <span className="k">קבועות שזוהו: {learned.length + (cf.manual?.length || 0)} פריטים</span>
        <span className={`v num${monthlyNet < 0 ? ' neg' : ''}`}>{fmtIls(monthlyNet)} לחודש</span>
      </div>

      {dip ? (
        <div className={dip.belowWarn ? 'dip-callout' : 'su-hint'} style={dip.belowWarn ? {} : { marginTop: 10 }}>
          נקודת השפל: <span className="num">{fmtIls(dip.projected)}</span> ב{hebDay(dip.date)}
          {dip.nextInflow ? <>, ואז נכנסים <span className="num">{fmtIls(dip.nextInflow.amount)}</span> ב{hebDay(dip.nextInflow.date)}</> : ', ללא הכנסה צפויה אחרי זה בטווח'}
          {dip.belowWarn ? ` · מתחת לסף ${fmtIls(cf.warnIls)}` : ''}
        </div>
      ) : null}

      <div className="cash-list">
        {eventDays.slice(0, horizon === 30 ? 7 : 12).map((d) => {
          const items = [...d.items].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
          const shown = items.slice(0, 4);
          const rest = items.length - shown.length;
          return (
            <div className="cash-day" key={d.date}>
              <div className="cash-day-head">
                <span className="d">{hebDay(d.date)}</span>
                <span className={`a num${Number(d.net) < 0 ? ' neg' : ' pos'}`}>{fmtIls(d.net)}</span>
                <span className="p num">יתרה {fmtIls(d.projected)}</span>
              </div>
              {shown.map((it, i) => (
                <div className="cash-item" key={`${it.name}-${i}`}>
                  <span className="n" title={it.name}>
                    {it.name}
                    {it.learned ? <span className="cash-tag">נלמד</span> : null}
                    {it.settlement ? <span className="cash-tag">סליקה</span> : null}
                  </span>
                  <span className={`a num${it.amount < 0 ? ' neg' : ' pos'}`}>{fmtIls(it.amount)}</span>
                </div>
              ))}
              {rest > 0 ? <div className="cash-more">ועוד {rest} {rest === 1 ? 'פריט' : 'פריטים'} קטנים יותר</div> : null}
            </div>
          );
        })}
      </div>

      {learned.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <button type="button" className="mp-chip" onClick={() => setShowLearned((v) => !v)}>
            {showLearned ? 'הסתר' : `מה נלמד מהבנק (${learned.length})`}
          </button>
          {showLearned ? (
            <div style={{ marginTop: 8 }}>
              {learned.map((it) => (
                <div className="kv" key={it.key} style={{ gap: 8 }}>
                  <span className="k" title={`נראה ב-${it.months} חודשים, ביטחון ${it.confidence}%`}>
                    {it.name.length > 28 ? `${it.name.slice(0, 28)}…` : it.name}
                    {' '}<span style={{ opacity: 0.55 }}>יום {it.day}</span>
                  </span>
                  <span className="v num" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span className={it.amount < 0 ? 'neg' : 'pos'}>{fmtIls(it.amount)}</span>
                    <button type="button" className="linkish" disabled={busy === it.name} onClick={() => act('confirm', it)}>אשר</button>
                    <button type="button" className="linkish" disabled={busy === it.name} onClick={() => act('ignore', it)}>לא קבוע</button>
                  </span>
                </div>
              ))}
              <p className="su-hint">"אשר" מקבע את הפריט ב-recurring.json; "לא קבוע" מוציא אותו מהתחזית. פריטים שלא סומנו נשארים בתחזית כניחוש.</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
