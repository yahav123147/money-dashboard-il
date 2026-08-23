import { fmtIls, hebMonth, hebDay, EmptyState } from './format';

const STATUS = {
  paid: ['שולם', 'tag gold'], partial: ['שולם חלקית', 'tag bad'], late: ['באיחור', 'tag bad'], pending: ['ממתין', 'tag'],
  refund: ['זיכוי / אפס', 'tag'], empty: ['אין נתונים', 'tag'],
};

function periodLabel(p) {
  return p.from === p.to ? hebMonth(p.from) : `${hebMonth(p.from)} עד ${hebMonth(p.to)}`;
}

export default function VatPanel({ vat }) {
  if (!vat) {
    return <section className="panel"><div className="panel-head"><h2>מע"מ</h2></div><EmptyState /></section>;
  }
  if (vat.applicable === false) {
    return (
      <section className="panel">
        <div className="panel-head"><h2>מע"מ</h2></div>
        <EmptyState text={vat.reason || 'לא רלוונטי'} />
      </section>
    );
  }
  const c = vat.closed;
  const o = vat.open;
  const [stLabel, stCls] = STATUS[c.status] || STATUS.pending;
  const periodWord = vat.periodMonths === 1 ? 'חודשי' : 'דו-חודשי';

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>מע"מ · {periodLabel(c)}</h2>
        <span className={stCls}>{stLabel}</span>
      </div>

      <div className="hero-secondary num">{fmtIls(Math.max(0, c.net))}</div>
      <div className="hero-sub">
        {c.net > 0 ? `לתשלום עד ${hebDay(c.due)}` : c.net < 0 ? `מע"מ להחזר ${fmtIls(-c.net)}` : 'אין חבות לתקופה'}
        {c.status === 'pending' && c.daysLeft >= 0 ? ` · עוד ${c.daysLeft} ימים` : ''}
        {c.status === 'late' ? ` · ${-c.daysLeft} ימים אחרי המועד` : ''}
        {c.status === 'partial' ? ` · חסר ${fmtIls(c.net - c.paid)}` : ''}
        {c.paid > 0 ? ` · שולם ${fmtIls(c.paid)}` : ''}
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="kv"><span className="k">מע"מ עסקאות (על {fmtIls(c.revenue)} הכנסות)</span><span className="v num">{fmtIls(c.outputVat)}</span></div>
        <div className="kv"><span className="k">מע"מ תשומות (על {fmtIls(c.inputBase)} הוצאות מוכרות)</span><span className="v num">−{fmtIls(c.inputVat)}</span></div>
        <div className="kv"><span className="k">נצבר לתקופה הפתוחה · {periodLabel(o)}</span><span className="v num">{fmtIls(o.net)}</span></div>
        <div className="kv"><span className="k">תדירות דיווח</span><span className="v">{periodWord}{vat.periodSource === 'turnover' ? ' (לפי מחזור)' : ''}</span></div>
      </div>

      {Array.isArray(vat.warnings) && vat.warnings.map((w) => <div className="su-err" key={w}>{w}</div>)}
      <p className="su-hint" style={{ marginTop: 10 }}>{vat.disclaimer}</p>
    </section>
  );
}
