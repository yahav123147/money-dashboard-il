import { fmtIls, EmptyState } from './format';

const STATUS = {
  on_track: ['בקצב', 'tag gold'], behind: ['בפיגור', 'tag bad'], ahead: ['משלם יותר מדי', 'tag'], unknown: ['', 'tag'],
};

export default function AdvancesYtd({ ytd }) {
  if (!ytd) {
    return <section className="panel"><div className="panel-head"><h2>מקדמות · מצטבר שנתי</h2></div><EmptyState /></section>;
  }
  const [stLabel, stCls] = STATUS[ytd.status] || STATUS.unknown;
  const est = ytd.annualEstimate;
  const range = (x) => (x && x.low !== x.high ? `${fmtIls(x.low)} עד ${fmtIls(x.high)}` : fmtIls(x?.low ?? x?.high ?? 0));

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>מקדמות · מצטבר {ytd.yearStart ? ytd.yearStart.slice(0, 4) : ''}</h2>
        {stLabel ? <span className={stCls}>{stLabel}</span> : null}
      </div>

      <div className="hero-secondary num">{fmtIls(ytd.paidYtd)}</div>
      <div className="hero-sub">שולם במקדמות מתחילת השנה ({ytd.monthsElapsed} חודשים)</div>

      {!est ? <div className="su-hint" style={{ marginTop: 12 }}>{ytd.note}</div> : (
        <div style={{ marginTop: 14 }}>
          <div className="kv"><span className="k">מס הכנסה שנתי צפוי</span><span className="v num">{range(est)}</span></div>
          <div className="kv">
            <span className="k">{ytd.gap.low > 0 ? 'חסר עד סוף השנה' : 'עודף מול הצפי'}</span>
            <span className="v num">{range({ low: Math.abs(ytd.gap.low), high: Math.abs(ytd.gap.high) })}</span>
          </div>
          {ytd.perMonthToClose && ytd.monthsLeft > 0 && ytd.gap.high > 0 ? (
            <div className="kv"><span className="k">נדרש לחודש ב-{ytd.monthsLeft} החודשים שנותרו</span><span className="v num">{range(ytd.perMonthToClose)}</span></div>
          ) : null}
          {ytd.currentRatePct != null && ytd.impliedRatePct ? (
            <div className="kv">
              <span className="k">שיעור מקדמה: נוכחי מול נדרש</span>
              <span className="v num">{ytd.currentRatePct}% ← {ytd.impliedRatePct.low}%{ytd.impliedRatePct.high !== ytd.impliedRatePct.low ? ` עד ${ytd.impliedRatePct.high}%` : ''}</span>
            </div>
          ) : null}
          {ytd.status === 'behind' ? (
            <div className="su-err">המקדמות נמוכות מהצפי. שתי אפשרויות: להגדיל את השיעור אצל פקיד השומה, או לשמור בצד {range(ytd.perMonthToClose)} לחודש ליתרת המס בדוח השנתי.</div>
          ) : null}
          {ytd.status === 'ahead' ? (
            <div className="su-hint" style={{ marginTop: 10 }}>משלם מעבר לצפי. אפשר לבקש הקטנת מקדמות (טופס בקשה דרך הרו"ח) ולשחרר תזרים.</div>
          ) : null}
          <p className="su-hint" style={{ marginTop: 10 }}>{ytd.note}</p>
        </div>
      )}
    </section>
  );
}
