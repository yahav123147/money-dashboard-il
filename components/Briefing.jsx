import { fmtIls, hebDay } from './format';

// Status hero: three stat tiles (the balance leads), then the four fixed
// briefing lines as a list. Tone: plain ink by default; gold dot = worth
// knowing; burgundy dot = money missing or a deadline passed. Nothing else
// gets color.
export function StatTiles({ b }) {
  const n = b?.numbers || {};
  const dip = n.dip;
  const np = n.nextPayment;
  return (
    <div className="stats">
      <div className="stat lead">
        <span className="stat-k">יתרה בבנק</span>
        <span className="stat-v num">{b ? fmtIls(n.balance || 0) : '···'}</span>
        <span className="stat-s">עו"ש, נכון להיום</span>
      </div>
      <div className="stat">
        <span className="stat-k">היתרה הנמוכה ביותר ב-30 יום</span>
        <span className={`stat-v num${dip && dip.amount < 0 ? ' neg' : ''}${dip ? '' : ' none'}`}>{dip ? fmtIls(dip.amount) : 'אין'}</span>
        <span className="stat-s">{dip ? `ב${hebDay(dip.date)}, אחרי ההוצאות הקבועות ולפני התקבול הבא` : 'אין תחזית עדיין'}</span>
      </div>
      <div className="stat">
        <span className="stat-k">תשלום המס הקרוב</span>
        <span className={`stat-v num${np ? '' : ' none'}`}>{np ? fmtIls(np.amount) : 'אין'}</span>
        <span className="stat-s">{np ? `${np.what} · עד ${hebDay(np.date)}` : 'לא ידוע על תשלום מס בשבועות הקרובים'}</span>
      </div>
    </div>
  );
}

export default function Briefing({ b }) {
  const lines = Array.isArray(b?.lines) ? b.lines : [];
  const todayCount = b?.todo?.today?.length || 0;
  const weekCount = b?.todo?.week?.length || 0;
  const mood = !b ? '' : todayCount ? `${todayCount === 1 ? 'דבר אחד' : `${todayCount} דברים`} לבדוק היום` : weekCount ? `${weekCount === 1 ? 'דבר אחד' : `${weekCount} דברים`} לשבוע` : 'יום שקט';
  return (
    <section className="panel brief">
      <div className="panel-head">
        <h2>תדריך בוקר</h2>
        <div className="side">{mood ? <span className={`badge${todayCount ? ' stale' : weekCount ? ' warn' : ' ok'}`}>{mood}</span> : null}</div>
      </div>
      {!b ? <p className="brief-loading">מכין את התדריך…</p> : (
        <ol className="brief-list">
          {lines.map((l) => (
            <li className={`brief-row tone-${l.tone || 'plain'}`} key={l.key}>
              <span className="brief-tag"><span className="brief-dot" />{l.label}</span>
              <span className="brief-text">{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
