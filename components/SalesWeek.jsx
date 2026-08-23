import Link from 'next/link';
import { fmtIls, fmtNum, EmptyState } from './format';

// Seven days of sales as one strip. The date label under each bar carries
// the settlement state: green = already in the bank, grey = still on its way,
// burgundy = did not arrive in time.
const DAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const STATE = { matched: 'הגיע לבנק', pending: 'בדרך לבנק', partial: 'הגיע בסכום שונה', missing: 'לא הגיע לבנק בזמן' };

export default function SalesWeek({ days }) {
  if (!Array.isArray(days) || days.length === 0) return null;
  const total = days.reduce((a, d) => a + d.total, 0);
  const count = days.reduce((a, d) => a + d.count, 0);
  const max = Math.max(1, ...days.map((d) => d.total));
  const dow = (iso) => DAYS[new Date(`${iso}T12:00:00`).getDay()];
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>מכירות · 7 ימים אחרונים</h2>
        <div className="side">
          <span className="badge">{fmtIls(total)}</span>
          <span className="badge">{fmtNum(count)} עסקאות</span>
          <Link href="/details#reconcile" className="linkish">להתאמה המלאה</Link>
        </div>
      </div>
      {total === 0 ? <EmptyState text="אין מכירות בשבוע האחרון" /> : (
        <>
          <div className="sw">
            {[...days].reverse().map((d) => (
              <div className="sw-day" key={d.date} title={d.status ? STATE[d.status] : ''}>
                <div className="sw-amt num">{d.total ? fmtIls(d.total) : ''}</div>
                <div className="sw-bar-wrap"><div className={`sw-bar st-${d.status || 'none'}`} style={{ height: `${Math.max(3, Math.round((d.total / max) * 100))}%` }} /></div>
                <div className={`sw-date st-${d.status || 'none'}`}>{dow(d.date)}׳ {Number(d.date.slice(8, 10))}.{Number(d.date.slice(5, 7))}</div>
              </div>
            ))}
          </div>
          <div className="sw-legend">
            <span><i className="sw-key st-matched" />הכסף כבר בבנק</span>
            <span><i className="sw-key st-pending" />בדרך</span>
            <span><i className="sw-key st-missing" />לא הגיע בזמן</span>
          </div>
        </>
      )}
    </section>
  );
}
