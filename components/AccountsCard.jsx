import { fmtCur, fmtIls, negCls, EmptyState } from './format';

const TYPE_LABELS = { CHECKING: 'עו"ש', CARD: 'כרטיס', SECURITIES: 'ני"ע', LOAN: 'מסגרת' };

export default function AccountsCard({ overview }) {
  if (!overview) {
    return (
      <section className="panel">
        <div className="panel-head"><h2>חשבונות וכרטיסים</h2></div>
        <EmptyState />
      </section>
    );
  }

  const balances = Array.isArray(overview.balances) ? overview.balances : [];
  const active = balances.filter((b) => Math.abs(Number(b.balance) || 0) >= 1);

  return (
    <section className="panel">
      <div className="panel-head"><h2>חשבונות וכרטיסים</h2></div>

      <div className="kv">
        <span className="k">חיוב כרטיסים קרוב (15 בחודש)</span>
        <span className={`v num ${negCls(-(Number(overview.upcomingCardCharge) || 0))}`.trim()}>
          {fmtIls(overview.upcomingCardCharge)}
        </span>
      </div>
      <div className="kv">
        <span className="k">מסגרת אשראי פנויה</span>
        <span className="v num">{fmtIls(overview.creditAvailable)}</span>
      </div>
      {Number(overview.creditBlocked) > 0 && (
        <div className="kv">
          <span className="k">מסגרות חסומות</span>
          <span className="v num" style={{ opacity: 0.6 }}>{fmtIls(overview.creditBlocked)}</span>
        </div>
      )}

      <details style={{ marginTop: 12 }} className="flag-group">
        <summary>
          <span className="dot sev-low" />
          כל החשבונות הפעילים
          <span className="sum">{active.length}</span>
        </summary>
        <div className="flag-items">
          {active.map((b, i) => (
            <div className="flag-item" key={`${b?.name || 'acct'}-${b?.currency || ''}-${i}`}>
              <span>
                {b?.name || 'חשבון'}
                <span style={{ opacity: 0.5, marginInlineStart: 6 }}>{TYPE_LABELS[b?.type] || b?.type}</span>
              </span>
              <span className="amt">{fmtCur(b?.balance, b?.currency || 'ILS')}</span>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
