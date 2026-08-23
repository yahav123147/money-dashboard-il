import { fmtIls, hebDay, EmptyState } from './format';

const DIP_WARN = 50000;

export default function Cashflow({ cashflow }) {
  if (!cashflow || !Array.isArray(cashflow.days)) {
    return (
      <section className="panel">
        <div className="panel-head"><h2>תזרים 30 יום</h2></div>
        <EmptyState />
      </section>
    );
  }

  const days = cashflow.days;
  const eventDays = days.filter((d) => Array.isArray(d.items) && d.items.length > 0);
  const dip = days.reduce(
    (m, d) => (Number(d.projected) < Number(m.projected) ? d : m),
    days[0] || { projected: Infinity }
  );
  const end = days[days.length - 1];

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>תזרים 30 יום קדימה</h2>
      </div>

      <div className="kv">
        <span className="k">יתרת עו"ש נוכחית</span>
        <span className="v num">{fmtIls(cashflow.startBalance)}</span>
      </div>
      <div className="kv">
        <span className="k">צפי לעוד 30 יום</span>
        <span className={`v num${Number(end?.projected) < 0 ? ' neg' : ''}`}>{fmtIls(end?.projected)}</span>
      </div>

      {Number(dip?.projected) < DIP_WARN ? (
        <div className="dip-callout">
          נקודת שפל: <span className="num">{fmtIls(dip.projected)}</span> ב{hebDay(dip.date)},
          לפני ההכנסה הבאה
        </div>
      ) : null}

      <div className="cash-list">
        {eventDays.slice(0, 7).map((d) => (
          <div className="cash-row" key={d.date}>
            <span className="d">{hebDay(d.date)}</span>
            <span className="n" title={d.items.map((i) => i.name).join(' · ')}>
              {d.items.map((i) => i.name).join(' · ')}
            </span>
            <span className={`a${Number(d.net) < 0 ? ' neg' : ' pos'}`}>{fmtIls(d.net)}</span>
            <span className="p">{fmtIls(d.projected)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
