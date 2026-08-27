'use client';

import { useEffect, useState } from 'react';
import { fmtIls, hebDay } from './format';

// One tile per bank: what is in it now, where the horizon leaves it, and the
// single item that moves it most. The tiles always sum to the headline
// balance above them, so the two can never tell different stories.
export default function BankTiles({ days = 30 }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let on = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/banks?days=${days}`, { cache: 'no-store' });
        const j = await res.json();
        if (on && !j.error) setD(j);
      } catch { /* keep the last good view */ }
    };
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { on = false; clearInterval(t); };
  }, [days]);

  const banks = d?.banks || [];
  if (!banks.length) return null;
  return (
    <div className="bank-tiles">
      {banks.map((b) => {
        const drop = b.projected - b.balance;
        const big = b.biggest;
        return (
          <div className="stat bank" key={b.provider}>
            <span className="stat-k">{b.label}</span>
            <span className={`stat-v num${b.balance < 0 ? ' neg' : ''}`}>{fmtIls(b.balance)}</span>
            <span className="stat-s">
              {`בעוד ${d.horizon} יום: ${fmtIls(b.projected)}`}
              {drop ? <span className={drop < 0 ? 'neg' : 'pos'}>{` (${drop > 0 ? '+' : ''}${fmtIls(drop)})`}</span> : null}
            </span>
            {big ? (
              <span className="bank-item">
                {`${big.amount < 0 ? 'הכי גדול שיוצא' : 'הכי גדול שנכנס'}: ${big.name.replace(/\s*\(.*\)$/, '')} · ${fmtIls(Math.abs(big.amount))} ב${hebDay(big.date)}`}
              </span>
            ) : <span className="bank-item quiet">אין תנועות צפויות בחשבון הזה</span>}
          </div>
        );
      })}
    </div>
  );
}
