'use client';

import { hebMonth } from './format';

// One control for the whole dashboard. Panels that cannot be historical
// (balances, today's sales, forward cashflow, open flags) do not read this —
// they carry an 'עדכני להיום' tag instead. See the spec's follows/does-not table.
export default function MonthPicker({ months, value, partial, onChange }) {
  if (!Array.isArray(months) || months.length === 0) return null;
  return (
    <nav className="mp" aria-label="בחירת חודש">
      {months.map((m) => (
        <button
          type="button"
          key={m}
          className={`mp-chip${m === value ? ' on' : ''}`}
          aria-pressed={m === value}
          onClick={() => onChange(m)}
        >
          {hebMonth(m)}
          {m === partial ? (
            <>
              {' '}
              <span className="mp-part">חלקי</span>
            </>
          ) : null}
        </button>
      ))}
    </nav>
  );
}
