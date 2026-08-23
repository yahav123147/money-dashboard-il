import Link from 'next/link';
import { fmtIls, fmtNum, hebDay, EmptyState } from './format';

// Seven days of sales, newest on the right (RTL: first in DOM). A check under a
// day means its settlement already landed in the bank; a dot means still in
// its window; a dash means it did not arrive in time.
const MARK = { matched: ['✓', 'הגיע לבנק'], pending: ['·', 'בדרך לבנק'], partial: ['≈', 'הגיע בסכום שונה'], missing: ['–', 'לא הגיע לבנק'] };

export default function SalesWeek({ days }) {
  if (!Array.isArray(days) || days.length === 0) return null;
  const total = days.reduce((a, d) => a + d.total, 0);
  const count = days.reduce((a, d) => a + d.count, 0);
  const max = Math.max(1, ...days.map((d) => d.total));
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>מכירות · 7 ימים</h2>
        <div className="side"><span className="badge">{fmtIls(total)} · {fmtNum(count)} עסקאות</span></div>
      </div>
      {total === 0 ? <EmptyState text="אין מכירות בשבוע האחרון" /> : (
        <div className="sw">
          {[...days].reverse().map((d) => {
            const m = d.status ? MARK[d.status] : null;
            return (
              <div className="sw-day" key={d.date} title={m ? m[1] : ''}>
                <div className="sw-bar-wrap"><div className="sw-bar" style={{ height: `${Math.max(4, Math.round((d.total / max) * 100))}%` }} /></div>
                <div className="sw-amt num">{d.total ? fmtIls(d.total) : ''}</div>
                <div className="sw-date">{hebDay(d.date)}</div>
                <div className={`sw-mark st-${d.status || 'none'}`}>{m ? m[0] : ''}</div>
              </div>
            );
          })}
        </div>
      )}
      <p className="su-hint" style={{ marginTop: 8 }}>✓ הכסף כבר בבנק · בדרך · – לא הגיע בזמן. <Link href="/details#reconcile" className="linkish">להתאמה המלאה</Link></p>
    </section>
  );
}
