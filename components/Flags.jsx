import { fmtIls, hebDay, EmptyState } from './format';

const GROUPS = {
  patur_ceiling: { label: 'תקרת עוסק פטור', order: -1 },
  settlement_missing: { label: 'זיכוי סליקה שלא נחת', order: -0.5 },
  advance: { label: 'מקדמת מס', order: 0 },
  sync: { label: 'סנכרון נתונים', order: 1 },
  unclassified: { label: 'תנועות לא מסווגות', order: 2 },
  large_amount: { label: 'תנועות גדולות', order: 3 },
  refund: { label: 'החזרים ללקוחות', order: 4 },
  new_counterparty: { label: 'מוטבים חדשים', order: 5 },
  channel_unmatched: { label: 'הכנסות ללא ערוץ', order: 7 },
};

const SEV = { high: 'sev-high', medium: 'sev-med', low: 'sev-low' };

export default function Flags({ flags }) {
  const list = Array.isArray(flags) ? flags : [];

  if (list.length === 0) {
    return (
      <section className="panel full">
        <div className="panel-head"><h2>דגלים</h2></div>
        <EmptyState text="שקט תעשייתי, אין דגלים פתוחים" />
      </section>
    );
  }

  const byType = new Map();
  for (const f of list) {
    const key = f?.type || 'other';
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(f);
  }

  const groups = [...byType.entries()].sort(
    (a, b) => (GROUPS[a[0]]?.order ?? 9) - (GROUPS[b[0]]?.order ?? 9)
  );

  return (
    <section className="panel full">
      <div className="panel-head">
        <h2>דגלים · {list.length}</h2>
      </div>
      <div className="flag-groups">
        {groups.map(([type, items]) => {
          const total = items.reduce((s, f) => s + Math.abs(Number(f?.amount) || 0), 0);
          const sev = items.some((f) => f?.severity === 'high')
            ? 'high'
            : items.some((f) => f?.severity === 'medium')
              ? 'medium'
              : 'low';
          return (
            <details className="flag-group" key={type} open={sev === 'high'}>
              <summary>
                <span className={`dot ${SEV[sev]}`} />
                {GROUPS[type]?.label || type}
                <span style={{ opacity: 0.5 }}>×{items.length}</span>
                {total > 0 ? <span className="sum num">{fmtIls(total)}</span> : null}
              </summary>
              <div className="flag-items">
                {items.map((f, i) => (
                  <div className="flag-item" key={i}>
                    <span>
                      {f?.text}
                      {f?.date ? <span style={{ opacity: 0.45, marginInlineStart: 8 }}>{hebDay(f.date)}</span> : null}
                    </span>
                    {f?.amount != null ? <span className="amt">{fmtIls(f.amount)}</span> : null}
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
