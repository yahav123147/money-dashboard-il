'use client';

import { fmtIls, Badge, EmptyState } from './format';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Cash profit and taxable income are different numbers. This panel shows the
// bridge between them, and — just as importantly — the amounts it cannot size.
// It reports a RANGE on purpose: the unknowns below are each larger than the
// adjustments above them.
export default function TaxView({ tax }) {
  if (!tax || !tax.estimate) {
    return (
      <section className="panel full">
        <div className="panel-head"><h2>מזומן מול הכנסה חייבת</h2></div>
        <EmptyState />
      </section>
    );
  }

  const a = tax.adjustments || {};
  const c = tax.cannotSize || {};
  const lo = num(tax.impliedRatePct?.low);
  const hi = num(tax.impliedRatePct?.high);
  const cur = num(tax.currentRatePct);
  // Below the whole range is a different statement from "inside it".
  const below = cur > 0 && lo > 0 && cur < lo;

  const steps = [
    { label: 'רווח לפי תזרים', value: num(tax.cashProfit), kind: 'base' },
    ...(a.notExpense || []).map((x) => ({
      label: `+ ${x.bucket === 'tax_advance' ? 'מקדמות מס — תשלום על חשבון המס, לא הוצאה' : x.bucket}`,
      value: num(x.amount), kind: 'up',
    })),
    ...(num(a.overCountedTotal) ? [{
      label: '+ החלק הלא-מוכר בהוצאות שנספרו במלואן',
      value: num(a.overCountedTotal), kind: 'up',
    }] : []),
    ...(num(a.recognised) ? [{
      label: '− הוצאות עסקיות שהיו מחוץ לקו, בשיעור ההכרה שלהן',
      value: -num(a.recognised), kind: 'down',
    }] : []),
  ];

  return (
    <section className="panel full tx">
      <div className="panel-head">
        <h2>מזומן מול הכנסה חייבת</h2>
        <div className="side">
          {tax.entityType ? (
            <Badge tone="">
              {{ patur: 'עוסק פטור', murshe: 'עוסק מורשה', company: 'חברה בע"מ' }[tax.entityType] || tax.entityType}
            </Badge>
          ) : null}
          <Badge tone="">{tax.period?.from}–{tax.period?.to}</Badge>
          <Badge tone={below ? 'stale' : 'ok'}>
            {below ? 'מתחת לטווח' : 'בתוך הטווח'}
          </Badge>
        </div>
      </div>

      <div className="tx-grid">
        <div>
          <div className="sec-title">הגשר</div>
          <ul className="tx-steps">
            {steps.map((s, i) => (
              <li className={`tx-step tx-${s.kind}`} key={i}>
                <span className="tx-lbl">{s.label}</span>
                <span className="v num">{fmtIls(s.value)}</span>
              </li>
            ))}
          </ul>

          <div className="tx-range">
            <div className="kick">הכנסה חייבת — הערכה</div>
            <div className="fig num">
              {fmtIls(num(tax.estimate.low))} – {fmtIls(num(tax.estimate.high))}
            </div>
            <div className="sub">
              שיעור מקדמה נגזר <span className="num">{lo}%</span>–<span className="num">{hi}%</span>
              {' · '}משלם היום <span className="num gold">{cur}%</span>
            </div>
          </div>

          {tax.taxEstimate?.high ? (
            <div className="tx-breakdown">
              <div className="sec-title">אומדן המס לתקופה — לפי הגבול העליון</div>
              <ul className="tx-steps">
                <li className="tx-step">
                  <span className="tx-lbl">מס הכנסה{tax.taxEstimate.high.creditPointsUsed != null
                    ? ` (אחרי ${tax.taxEstimate.high.creditPointsUsed} נק' זיכוי)` : ''}</span>
                  <span className="v num">{fmtIls(num(tax.taxEstimate.high.incomeTax))}</span>
                </li>
                {num(tax.taxEstimate.high.nationalInsurance) + num(tax.taxEstimate.high.healthInsurance) > 0 ? (
                  <li className="tx-step">
                    <span className="tx-lbl">ביטוח לאומי + בריאות (מקדמות נפרדות של ב"ל)</span>
                    <span className="v num">
                      {fmtIls(num(tax.taxEstimate.high.nationalInsurance) + num(tax.taxEstimate.high.healthInsurance))}
                    </span>
                  </li>
                ) : null}
                <li className="tx-step tx-base">
                  <span className="tx-lbl">סך חבות משוערת</span>
                  <span className="v num">{fmtIls(num(tax.taxEstimate.high.total))}</span>
                </li>
              </ul>
              {(tax.taxEstimate.high.engineNotes || []).map((n, i) => (
                <p className="tx-why" key={i}>{n}</p>
              ))}
            </div>
          ) : null}
        </div>

        <div>
          <div className="sec-title">מה שלא ניתן לכמת</div>
          <ul className="tx-unk">
            {num(c.secondAccount) ? (
              <li><span>{c.secondAccountLabel || 'הוצאות מחשבון בנק שני'}</span><span className="v num">{fmtIls(num(c.secondAccount))}</span></li>
            ) : null}
            {num(c.cappedRules) ? (
              <li><span>נסיעות לחו"ל — תקרות לכל נסיעה</span><span className="v num">{fmtIls(num(c.cappedRules))}</span></li>
            ) : null}
            {num(c.needsClassification) ? (
              <li><span>ממתין לסיווג</span><span className="v num">{fmtIls(num(c.needsClassification))}</span></li>
            ) : null}
          </ul>
          <p className="tx-why">
            שלושת אלה גדולים מכל ההתאמות שמשמאל, ולכן התוצאה היא טווח ולא מספר.
            רוחב הטווח הוא בדיוק מה שלא ידוע.
          </p>

          {(a.belowLineBusiness || []).length ? (
            <>
              <div className="sec-title">שיעורי הכרה שהופעלו</div>
              <ul className="tx-rules">
                {a.belowLineBusiness.map((x) => (
                  <li key={x.key}>
                    <span>{x.label}</span>
                    <span className="tx-rate num">{x.rate === null ? '—' : `${Math.round(x.rate * 100)}%`}</span>
                    <span className="v num">{fmtIls(num(x.gross))}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>

      <p className="tx-disc">{tax.disclaimer}</p>
    </section>
  );
}
