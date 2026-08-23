'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Shared data layer for both screens: the setup gate, the endpoint poll, and
// the month selection the details screen needs. Status passes a short
// endpoint list; details the full one.
export const REFRESH_MS = 60_000;

export function useDashboard(endpoints) {
  const [data, setData] = useState(() => Object.fromEntries(endpoints.map((e) => [e, null])));
  const [lastFetch, setLastFetch] = useState(null);
  const [month, setMonth] = useState(null);
  const [setup, setSetup] = useState(null);
  const [showSetup, setShowSetup] = useState(false);

  const loadSetup = useCallback(async () => {
    try {
      const res = await fetch('/api/setup', { cache: 'no-store' });
      const json = res.ok ? await res.json() : { configured: true };
      setSetup(json);
      return json;
    } catch { setSetup({ configured: true }); return null; }
  }, []);
  useEffect(() => { loadSetup(); }, [loadSetup]);

  const monthRef = useRef(null);
  const fetchAll = useCallback(async () => {
    const fresh = {};
    await Promise.all(endpoints.map(async (name) => {
      try {
        const qs = name === 'advances' && monthRef.current ? `?month=${monthRef.current}` : '';
        const res = await fetch(`/api/${name}${qs}`, { cache: 'no-store' });
        fresh[name] = res.ok ? await res.json() : null;
      } catch { fresh[name] = null; }
    }));
    setData((prev) => { const next = { ...prev }; for (const n of endpoints) if (fresh[n] != null) next[n] = fresh[n]; return next; });
    setLastFetch(new Date());
  }, [endpoints]);

  const pnlMonths = Array.isArray(data.pnl?.months) ? data.pnl.months : [];
  const monthList = pnlMonths.map((m) => m.month);
  const partialMonth = pnlMonths.find((m) => m.partial)?.month || null;
  const lastComplete = [...pnlMonths].reverse().find((m) => !m.partial)?.month || monthList[monthList.length - 1] || null;
  const selMonth = month && monthList.includes(month) ? month : lastComplete;
  const isPast = Boolean(selMonth && monthList.length && selMonth !== monthList[monthList.length - 1]);

  useEffect(() => { monthRef.current = selMonth; }, [selMonth]);
  useEffect(() => { fetchAll(); const t = setInterval(fetchAll, REFRESH_MS); return () => clearInterval(t); }, [fetchAll]);
  useEffect(() => { if (month) fetchAll(); }, [month, fetchAll]);
  useEffect(() => { if (!month && selMonth) fetchAll(); }, [selMonth]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, lastFetch, fetchAll, month, setMonth, selMonth, monthList, partialMonth, isPast, setup, showSetup, setShowSetup, loadSetup };
}
