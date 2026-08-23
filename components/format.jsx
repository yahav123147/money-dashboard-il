// Shared formatting helpers + tiny UI atoms for the money dashboard.
// All amounts are formatted with he-IL locale (thousands separators, correct minus placement in RTL).

export function fmtCur(n, currency = 'ILS') {
  const v = Number(n);
  if (n == null || n === '' || !Number.isFinite(v)) return '···';
  return new Intl.NumberFormat('he-IL', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(v);
}

export function fmtIls(n) {
  return fmtCur(n, 'ILS');
}

export function fmtNum(n) {
  const v = Number(n);
  if (n == null || n === '' || !Number.isFinite(v)) return '···';
  return v.toLocaleString('he-IL', { maximumFractionDigits: 0 });
}

// sign class: negative red, positive green (use only where positive=good, e.g. profit/net)
export function signCls(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '';
  return v < 0 ? 'neg' : 'pos';
}

// negative-only coloring (balances etc.: positive stays neutral)
export function negCls(n) {
  const v = Number(n);
  return Number.isFinite(v) && v < 0 ? 'neg' : '';
}

// headline: gold unless negative (negative wins, shown red)
export function headlineCls(n) {
  const v = Number(n);
  return Number.isFinite(v) && v < 0 ? 'headline neg' : 'headline gold';
}

export function timeAgo(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const rtf = new Intl.RelativeTimeFormat('he', { numeric: 'auto' });
  if (Math.abs(mins) < 60) return rtf.format(-mins, 'minute');
  const hrs = Math.round(mins / 60);
  if (Math.abs(hrs) < 24) return rtf.format(-hrs, 'hour');
  return rtf.format(-Math.round(hrs / 24), 'day');
}

export function hebMonth(ym) {
  if (!ym) return '···';
  try {
    const d = new Date(`${ym}-01T00:00:00`);
    if (Number.isNaN(d.getTime())) return ym;
    return d.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
  } catch {
    return ym;
  }
}

export function hebDay(s) {
  if (!s) return '···';
  try {
    const d = new Date(s.includes('T') ? s : `${s}T00:00:00`);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric' });
  } catch {
    return s;
  }
}

export function Badge({ tone = '', children }) {
  return <span className={`badge ${tone}`.trim()}>{children}</span>;
}

// Staleness badge: ok / warn (older than warnMinutes) / stale (older than 3x warnMinutes or missing)
export function StaleBadge({ label, iso, warnMinutes = 60 }) {
  const ago = timeAgo(iso);
  let tone = 'ok';
  if (!iso || !ago) {
    tone = 'stale';
  } else {
    const ageMin = (Date.now() - new Date(iso).getTime()) / 60000;
    if (ageMin > warnMinutes * 3) tone = 'stale';
    else if (ageMin > warnMinutes) tone = 'warn';
  }
  return (
    <Badge tone={tone}>
      {label}: {ago || 'אין נתונים'}
    </Badge>
  );
}

export function EmptyState({ text = 'אין נתונים עדיין' }) {
  return <div className="empty">{text}</div>;
}
