'use client';

import { useEffect, useState } from 'react';
import { fmtIls, fmtNum, StaleBadge, EmptyState, hebDay } from './format';

// CardCom sales panel (optional module). Hidden entirely when config/cardcom.json
// has enabled=false. Self-contained: it polls /api/sales on its own and does
// not follow the month picker — sales are a "right now" view, like balances.

// Israel calendar date shifted by `days`; mirrors lib/queries israelToday so the
// chips line up with the server's day boundaries whatever the machine's zone.
function israelDate(days = 0) {
  const d = new Date(Date.now() + days * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
}

const PRESETS = [
  { key: 'today', label: 'היום', days: 0 },
  { key: 'yesterday', label: 'אתמול', days: -1 },
  { key: 'before', label: 'שלשום', days: -2 },
  { key: 'week', label: '7 ימים', days: -6 },
];

export default function Sales() {
  const [sel, setSel] = useState('today');
  const [pickDate, setPickDate] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const today = israelDate(0);
  const preset = PRESETS.find((p) => p.key === sel);
  const from = sel === 'date' ? pickDate : israelDate(preset?.days ?? 0);
  const to = sel === 'week' ? today : from;

  useEffect(() => {
    if (!from) return undefined;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/sales?from=${from}&to=${to}`, { cache: 'no-store' });
        const json = res.ok ? await res.json() : null;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [from, to]);

  // First answer decides whether the panel exists at all.
  if (data && data.enabled === false) return null;

  const current = data && data.from === from && data.to === to ? data : null;
  const title = sel === 'today' ? 'מכירות היום'
    : sel === 'week' ? 'מכירות · 7 ימים אחרונים'
    : `מכירות · ${hebDay(from)}`;

  const byProduct = current?.byProduct && typeof current.byProduct === 'object' ? current.byProduct : {};
  const products = Object.entries(byProduct)
    .sort((a, b) => (Number(b[1]?.total) || 0) - (Number(a[1]?.total) || 0));
  const count = Number(current?.count) || 0;

  let sub = '';
  if (!current) sub = loading ? 'טוען…' : '';
  else if (count === 0) sub = sel === 'today' ? 'אין עסקאות עדיין היום' : 'אין עסקאות';
  else if (sel === 'today') sub = `${fmtNum(count)} עסקאות מתחילת היום`;
  else if (sel === 'week') sub = `${fmtNum(count)} עסקאות · ממוצע ${fmtIls(current.total / 7)} ליום`;
  else sub = `${fmtNum(count)} עסקאות`;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title} · קארדקום</h2>
        <div className="side">
          <StaleBadge label="עודכן" iso={data?.lastSync} warnMinutes={45} />
        </div>
      </div>

      <nav className="mp" style={{ margin: '0 0 12px' }} aria-label="בחירת יום">
        {PRESETS.map((p) => (
          <button
            type="button"
            key={p.key}
            className={`mp-chip${sel === p.key ? ' on' : ''}`}
            aria-pressed={sel === p.key}
            onClick={() => setSel(p.key)}
          >
            {p.label}
          </button>
        ))}
        <input
          type="date"
          className={`mp-chip${sel === 'date' ? ' on' : ''}`}
          aria-label="בחירת תאריך"
          value={pickDate}
          max={today}
          onChange={(e) => { const v = e.target.value; setPickDate(v); if (v) setSel('date'); }}
          onFocus={() => { if (pickDate) setSel('date'); }}
        />
      </nav>

      {sel === 'date' && !pickDate ? (
        <div className="hero-sub">בחר תאריך</div>
      ) : !current && !loading ? (
        <EmptyState />
      ) : (
        <>
          <div className="hero-secondary num" style={{ opacity: loading ? 0.5 : 1 }}>{fmtIls(current?.total || 0)}</div>
          <div className="hero-sub">{sub}</div>
        </>
      )}

      {sel === 'week' && Array.isArray(current?.days) && current.days.length > 0 ? (
        <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: '0.74rem', color: 'var(--ink-3)' }}>
          {current.days.map((d) => (
            <span key={d.date} style={{ border: '1px solid var(--line-soft)', borderRadius: 8, padding: '3px 8px' }}>
              {d.date.slice(8, 10)}.{d.date.slice(5, 7)} <span className="num" style={{ color: 'var(--ink-2)' }}>{fmtIls(d.total)}</span>
            </span>
          ))}
        </div>
      ) : null}

      {products.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          {products.map(([name, p]) => (
            <div className="kv" key={name}>
              <span className="k" title={name}>
                {p?.unknown ? '⁇ ' : ''}
                {name.length > 40 ? `${name.slice(0, 40)}…` : name}
                {' '}<span style={{ opacity: 0.55 }}>×{fmtNum(p?.count)}</span>
              </span>
              <span className="v num">{fmtIls(p?.total)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
