'use client';

import { useState } from 'react';
import { fmtIls, hebMonth, signCls, EmptyState } from './format';

const EXPENSE_LABELS = {
  team: 'צוות',
  cards: 'כרטיסי אשראי',
  tax_vat: 'מע"מ',
  tax_advance: 'מקדמות מס',
  tax_withholding: 'ניכויים',
  tax_social: 'ביטוח לאומי',
  rent: 'שכירות',
  pension: 'פנסיה',
  suppliers_other: 'ספקים אחר',
  unclassified: 'לא מסווג',
};

const REVENUE_LABELS = {
  direct: 'העברות ישירות',
  other_revenue: 'אחר',
};

export default function PnlTable({ pnl, month }) {
  const [open, setOpen] = useState(null);

  if (!pnl || !Array.isArray(pnl.months) || pnl.months.length === 0) {
    return (
      <section className="panel full">
        <div className="panel-head"><h2>רווח והפסד חודשי</h2></div>
        <EmptyState />
      </section>
    );
  }

  const months = [...pnl.months].reverse(); // latest first
  const avg = typeof pnl.avg3m === 'object' ? pnl.avg3m?.operating_profit : pnl.avg3m;

  return (
    <section className="panel full">
      <div className="panel-head">
        <h2>רווח והפסד חודשי</h2>
        <div className="side">
          <span className="badge">לחיצה על שורה לפירוט מלא</span>
          <span className="badge">ממוצע 3 חודשים: <b className="num" style={{ marginInlineStart: 4 }}>{fmtIls(avg)}</b></span>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>חודש</th>
              <th className="num">הכנסות</th>
              <th className="num">ללא מע"מ</th>
              <th className="num">החזרים</th>
              <th className="num">הוצאות</th>
              <th className="num">רווח תפעולי</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => {
              const expTotal = Object.values(m.expenses || {}).reduce((s, v) => s + (Number(v) || 0), 0);
              const isOpen = open === m.month;
              return [
                <tr
                  key={m.month}
                  className={month === m.month ? 'pnl-on' : undefined}
                  onClick={() => setOpen(isOpen ? null : m.month)}
                  style={{ cursor: 'pointer' }}
                >
                  <td className="strong">
                    {hebMonth(m.month)}
                    {m.partial ? <span className="tag gold">חלקי</span> : null}
                  </td>
                  <td className="num">{fmtIls(m.revenue_gross)}</td>
                  <td className="num" style={{ opacity: 0.6 }}>{fmtIls(m.revenue_ex_vat)}</td>
                  <td className={`num ${Number(m.refunds) < 0 ? 'neg' : ''}`.trim()}>{fmtIls(m.refunds)}</td>
                  <td className="num">{fmtIls(expTotal)}</td>
                  <td className={`num profit-cell ${signCls(m.operating_profit)}`.trim()}>{fmtIls(m.operating_profit)}</td>
                </tr>,
                isOpen ? (
                  <tr className="expand-row" key={`${m.month}-x`}>
                    <td colSpan={6}>
                      <div className="chips-line">
                        {Object.entries(m.revenue_breakdown || {})
                          .filter(([k, v]) => REVENUE_LABELS[k] && Number(v) !== 0)
                          .map(([k, v]) => (
                            <span className="mini" key={k}>{REVENUE_LABELS[k]} <b className="num">{fmtIls(v)}</b></span>
                          ))}
                      </div>
                      <div className="chips-line">
                        {Object.entries(m.expenses || {})
                          .filter(([, v]) => Number(v) !== 0)
                          .map(([k, v]) => (
                            <span className="mini" key={k}>{EXPENSE_LABELS[k] || k} <b className="num">{fmtIls(v)}</b></span>
                          ))}
                      </div>
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
