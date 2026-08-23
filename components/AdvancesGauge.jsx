import { fmtIls, hebMonth, EmptyState } from './format';

export default function AdvancesGauge({ advances }) {
  if (!advances) {
    return (
      <section className="panel">
        <div className="panel-head"><h2>מקדמות מס הכנסה</h2></div>
        <EmptyState />
      </section>
    );
  }

  const pct = Math.max(0, Math.min(100, Number(advances.paidPct) || 0));
  const late = advances.status === 'late';
  const paidUp = advances.status === 'paid';
  const daysLeft = Number(advances.daysLeft);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>מקדמות מס · {hebMonth(advances.month)}</h2>
        {paidUp ? <span className="tag gold">שולם</span> : null}
      </div>

      <div className="kv">
        <span className="k">מחזור חודש קודם (ללא מע"מ)</span>
        <span className="v num">{fmtIls(advances.turnoverExVat)}</span>
      </div>
      <div className="kv">
        <span className="k">יעד מקדמה ({advances.ratePct}%)</span>
        <span className="v num gold">{fmtIls(advances.targetAmount)}</span>
      </div>
      <div className="kv">
        <span className="k">שולם בפועל</span>
        <span className="v num">{fmtIls(advances.paid)}</span>
      </div>
      {advances.requiredRatePct != null && (
        <div className="kv">
          <span className="k">נדרש לפי הרווח בפועל</span>
          <span className={`v num${advances.requiredRatePct - advances.ratePct >= 0.5 ? ' neg' : ''}`.trim()}>
            {advances.requiredRatePct}% · פער {fmtIls(advances.annualGapIls)} לשנה
          </span>
        </div>
      )}

      <div className="gauge-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="gauge-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="gauge-meta"><span>{pct}% מהיעד</span><span className="num">15 לחודש</span></div>

      {!paidUp ? (
        <div className={`deadline${late ? ' late' : ''}`}>
          {late
            ? 'הדדליין עבר, המקדמה טרם שולמה'
            : Number.isFinite(daysLeft)
              ? `נותרו ${daysLeft} ימים לתשלום`
              : ''}
        </div>
      ) : null}
    </section>
  );
}
