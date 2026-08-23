'use client';

import { useEffect, useState } from 'react';

// "הסוכן הפיננסי": the last review written by scripts/review.mjs through the
// user's Claude subscription. Rendered as the four fixed sections; an empty
// state explains how to run it. Nothing here calls any AI from the browser.
function render(text) {
  const blocks = [];
  let list = null;
  const flush = () => { if (list) { blocks.push(<ul key={blocks.length}>{list}</ul>); list = null; } };
  for (const raw of (text || '').split('\n')) {
    const line = raw.trimEnd();
    if (/^###\s/.test(line)) { flush(); blocks.push(<h3 key={blocks.length}>{line.replace(/^###\s*/, '')}</h3>); }
    else if (/^[-*]\s/.test(line)) { list = list || []; list.push(<li key={list.length}>{line.replace(/^[-*]\s*/, '')}</li>); }
    else if (line.trim() === '') { flush(); }
    else { flush(); blocks.push(<p key={blocks.length}>{line}</p>); }
  }
  flush();
  return blocks;
}

export default function Review() {
  const [r, setR] = useState(null);
  useEffect(() => {
    let on = true;
    const load = async () => { try { const res = await fetch('/api/review', { cache: 'no-store' }); const j = await res.json(); if (on) setR(j); } catch { /* keep */ } };
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { on = false; clearInterval(t); };
  }, []);
  const when = r?.ts ? new Date(r.ts).toLocaleString('he-IL', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <section className="panel" id="review">
      <div className="panel-head">
        <h2>הסוכן הפיננסי</h2>
        <div className="side">{r?.ok ? <span className="badge ok">סקירה מ-{when}</span> : r && !r.empty ? <span className="badge stale">הסקירה האחרונה נכשלה</span> : null}</div>
      </div>
      {!r ? <p className="brief-loading">טוען…</p> : r.ok ? (
        <div className="review">{render(r.text)}</div>
      ) : r.empty ? (
        <p className="review-empty">
          עדיין לא רצה סקירה. הסוכן עובר על המספרים שבמסך, מצליב אותם עם בדיקות האיכות, ואומר בעברית פשוטה מה נכון ומה לתקן.
          מריצים <code>npm run review</code> (כמה דקות, רץ על מנוי Claude שלך), או <code>/review</code> בתוך Claude Code כשרוצים לדבר איתו.
        </p>
      ) : (
        <p className="review-empty">הריצה האחרונה נכשלה: {r.error}. לוודא ש-<code>claude</code> מותקן ומחובר (<code>claude login</code>), ולהריץ שוב <code>npm run review</code>.</p>
      )}
    </section>
  );
}
