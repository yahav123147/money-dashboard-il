'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Hero from '@/components/Hero';
import Sales from '@/components/Sales';
import Reconcile from '@/components/Reconcile';
import VatPanel from '@/components/VatPanel';
import AdvancesYtd from '@/components/AdvancesYtd';
import Channels from '@/components/Channels';
import AccountsCard from '@/components/AccountsCard';
import PnlTable from '@/components/PnlTable';
import Expenses from '@/components/Expenses';
import AdvancesGauge from '@/components/AdvancesGauge';
import Cashflow from '@/components/Cashflow';
import Flags from '@/components/Flags';
import Bottomline from '@/components/Bottomline';
import MonthPicker from '@/components/MonthPicker';
import Setup from '@/components/Setup';
import TaxView from '@/components/TaxView';

const ENDPOINTS = ['overview', 'pnl', 'advances', 'cashflow', 'expenses', 'tax', 'vat', 'advances-ytd'];
const REFRESH_MS = 60_000;

export default function Page() {
  const [data, setData] = useState(Object.fromEntries(ENDPOINTS.map((e) => [e, null])));
  const [month, setMonth] = useState(null);
  // null = not checked yet; {configured:false} = show the wizard; forced via the masthead link
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
  const [lastFetch, setLastFetch] = useState(null);
  const monthRef = useRef(null);

  const fetchAll = useCallback(async () => {
    const fresh = {};
    await Promise.all(ENDPOINTS.map(async (name) => {
      try {
        const qs = name === 'advances' && monthRef.current ? `?month=${monthRef.current}` : '';
        const res = await fetch(`/api/${name}${qs}`, { cache: 'no-store' });
        fresh[name] = res.ok ? await res.json() : null;
      } catch { fresh[name] = null; }
    }));
    setData((prev) => {
      const next = { ...prev };
      for (const n of ENDPOINTS) if (fresh[n] != null) next[n] = fresh[n];
      return next;
    });
    setLastFetch(new Date());
  }, []);

  const { overview, pnl, advances, cashflow, expenses, tax, vat } = data;
  const advancesYtd = data['advances-ytd'];

  const pnlMonths = Array.isArray(pnl?.months) ? pnl.months : [];
  const monthList = pnlMonths.map((m) => m.month);
  const partialMonth = pnlMonths.find((m) => m.partial)?.month || null;
  const lastComplete = [...pnlMonths].reverse().find((m) => !m.partial)?.month
    || monthList[monthList.length - 1] || null;
  const selMonth = month && monthList.includes(month) ? month : lastComplete;
  const isPast = Boolean(selMonth && monthList.length && selMonth !== monthList[monthList.length - 1]);

  useEffect(() => { monthRef.current = selMonth; }, [selMonth]);
  useEffect(() => { fetchAll(); const t = setInterval(fetchAll, REFRESH_MS); return () => clearInterval(t); }, [fetchAll]);
  useEffect(() => { if (month) fetchAll(); }, [month, fetchAll]);
  useEffect(() => { if (!month && selMonth) fetchAll(); }, [selMonth]); // eslint-disable-line react-hooks/exhaustive-deps

  const today = new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });

  if (setup === null) {
    return <main className="container"><p className="su-intro" style={{ textAlign: 'center', marginTop: 60 }}>טוען…</p></main>;
  }
  if (!setup.configured || showSetup) {
    return (
      <main className="container">
        <header className="masthead">
          <div><div className="kicker">חדר מצב כסף</div><h1>ברוך הבא</h1></div>
        </header>
        <Setup status={setup} onDone={async () => { setShowSetup(false); await loadSetup(); fetchAll(); }} />
        <footer>מקומי בלבד · הנתונים לא יוצאים מהמחשב שלך</footer>
      </main>
    );
  }

  return (
    <main className="container">
      <header className="masthead">
        <div>
          <div className="kicker">חדר מצב כסף</div>
          <h1>המספרים שלך</h1>
        </div>
        <div className="meta">
          <span className="badge">{today}</span>
          {lastFetch
            ? <span className="badge ok">עודכן {lastFetch.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}</span>
            : <span className="badge">טוען...</span>}
          <button type="button" className="linkish" onClick={() => setShowSetup(true)}>הגדרות</button>
        </div>
      </header>

      <MonthPicker months={monthList} value={selMonth} partial={partialMonth} onChange={setMonth} />

      <Bottomline pnl={pnl} advances={advances} month={selMonth} />

      <div className={isPast ? 'as-of-today' : ''}><Hero overview={overview} /></div>

      <div className="grid-2">
        <div className={isPast ? 'as-of-today' : ''}><Sales /></div>
        <div className={isPast ? 'as-of-today' : ''}><Reconcile /></div>
      </div>

      <div className="grid-3">
        <div className="g3-cell"><AdvancesGauge advances={advances} /></div>
        <div className={`g3-cell${isPast ? ' as-of-today' : ''}`}><Cashflow cashflow={cashflow} /></div>
        <div className={`g3-cell${isPast ? ' as-of-today' : ''}`}><AccountsCard overview={overview} /></div>
      </div>

      <Channels month={selMonth} />

      <div className="grid-2">
        <div><VatPanel vat={vat} /></div>
        <div><AdvancesYtd ytd={advancesYtd} /></div>
      </div>

      <PnlTable pnl={pnl} month={selMonth} />
      <Expenses expenses={expenses} month={selMonth} />
      <TaxView tax={tax} />
      <div className={isPast ? 'as-of-today' : ''}><Flags flags={overview?.flags} /></div>

      <footer>מקומי בלבד · הנתונים לא יוצאים מהמחשב שלך</footer>
    </main>
  );
}
