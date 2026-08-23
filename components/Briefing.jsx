import { fmtIls, hebDay, EmptyState } from './format';

// The morning briefing: four lines, fixed order, then three numbers.
// Tone: plain ink by default. 'attention' = gold dot. 'action' = the one
// burgundy dot on the page, reserved for missing money and passed deadlines.
export default function Briefing({ b }) {
  if (!b) return <section className="panel brief"><EmptyState text="מכין את התדריך…" /></section>;
  const lines = Array.isArray(b.lines) ? b.lines : [];
  const n = b.numbers || {};
  return (
    <section className={`panel brief${b.quiet ? ' quiet' : ''}`}>
      <div className="brief-lines">
        {lines.map((l) => (
          <div className={`brief-line tone-${l.tone || 'plain'}`} key={l.key}>
            <span className="brief-label"><span className="brief-dot" />{l.label}</span>
            <span className="brief-text">{l.text}</span>
          </div>
        ))}
      </div>
      <div className="brief-nums">
        <div className="brief-num">
          <span className="k">יתרה בבנק</span>
          <span className="v num">{fmtIls(n.balance || 0)}</span>
        </div>
        <div className="brief-num">
          <span className="k">הנקודה הנמוכה הקרובה</span>
          <span className={`v num${n.dip && n.dip.amount < 0 ? ' neg' : ''}`}>{n.dip ? fmtIls(n.dip.amount) : '···'}</span>
          <span className="s">{n.dip ? hebDay(n.dip.date) : ''}</span>
        </div>
        <div className="brief-num">
          <span className="k">התשלום הבא</span>
          <span className="v num">{n.nextPayment ? fmtIls(n.nextPayment.amount) : '···'}</span>
          <span className="s">{n.nextPayment ? `${n.nextPayment.what} · ${hebDay(n.nextPayment.date)}` : 'אין תשלום מס פתוח'}</span>
        </div>
      </div>
    </section>
  );
}
