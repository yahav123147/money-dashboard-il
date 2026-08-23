import { fmtIls, StaleBadge, Badge, EmptyState } from './format';

const USD_ILS = 3.05;

function Sparkline({ trend }) {
  if (!Array.isArray(trend) || trend.length < 2) {
    return (
      <div className="spark-wrap">
        <div className="spark-note">
          נאספת היסטוריית יתרות · נקודה ראשונה נרשמה היום, הגרף ייבנה מעצמו בימים הקרובים
        </div>
      </div>
    );
  }
  const W = 620, H = 74, P = 6;
  const vals = trend.map((t) => Number(t?.total) || 0);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const pts = vals.map((v, i) => [
    P + (i * (W - 2 * P)) / (vals.length - 1),
    H - P - ((v - min) * (H - 2 * P)) / span,
  ]);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${P},${H - P} ${line} ${(W - P).toFixed(1)},${H - P}`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <div className="spark-wrap">
      <div dir="ltr">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}
          style={{ maxWidth: '100%', height: 'auto', display: 'block' }}
          role="img" aria-label="מגמת נזילות">
          <defs>
            <linearGradient id="goldfill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#8A6A25" stopOpacity="0.15" />
              <stop offset="100%" stopColor="#8A6A25" stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon points={area} fill="url(#goldfill)" />
          <polyline points={line} fill="none" stroke="#8A6A25" strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={lx.toFixed(1)} cy={ly.toFixed(1)} r="3.5" fill="#6E5420" />
        </svg>
      </div>
      <div className="spark-note">מגמת נזילות · {trend.length} ימים</div>
    </div>
  );
}

export default function Hero({ overview }) {
  if (!overview) {
    return (
      <section className="panel">
        <div className="panel-head"><h2>נזילות</h2></div>
        <EmptyState />
      </section>
    );
  }

  const balances = Array.isArray(overview.balances) ? overview.balances : [];
  const staleness = overview.staleness || {};

  const sum = (fn) => balances.filter(fn).reduce((s, b) => s + (Number(b.balance) || 0), 0);
  const checkingIls = sum((b) => b.type === 'CHECKING' && b.currency === 'ILS');
  const securities = balances
    .filter((b) => b.type === 'SECURITIES')
    .reduce((s, b) => s + (Number(b.balance) || 0), 0);
  const fxIls = balances
    .filter((b) => b.type === 'CHECKING' && b.currency !== 'ILS')
    .reduce((s, b) => s + (Number(b.balance) || 0) * (b.currency === 'USD' ? USD_ILS : 3.5), 0);

  const total = Number(overview.liquidTotal) || 0;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>נזילות זמינה</h2>
        <div className="side">
          <StaleBadge label="בנק" iso={staleness.bankAsOf} warnMinutes={30 * 60} />
          {staleness.bankRefreshSkipped ? <Badge tone="warn">רענון דולג</Badge> : null}
        </div>
      </div>

      <div className={`hero-figure num${total < 0 ? ' neg' : ''}`}>{fmtIls(total)}</div>
      <div className="hero-sub">עו"ש + קרנות כספיות + מט"ח, בשקלים</div>

      <div className="break-chips">
        <span className="bchip">עו"ש<b className="num">{fmtIls(checkingIls)}</b></span>
        <span className="bchip">כספיות<b className="num">{fmtIls(securities)}</b></span>
        <span className="bchip">מט"ח<b className="num">≈{fmtIls(fxIls)}</b></span>
      </div>

      <Sparkline trend={overview.trend} />
    </section>
  );
}
