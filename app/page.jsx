'use client';

import Link from 'next/link';
import { useDashboard } from '@/components/useDashboard';
import Shell from '@/components/Shell';
import Briefing, { StatTiles } from '@/components/Briefing';
import BankTiles from '@/components/BankTiles';
import Todo from '@/components/Todo';
import SalesWeek from '@/components/SalesWeek';
import Sales from '@/components/Sales';

// Status screen: "what is the situation, and what do I do today?"
// Three numbers → four lines → three columns of things to do → the week.
const ENDPOINTS = ['briefing'];

export default function StatusPage() {
  const dash = useDashboard(ENDPOINTS);
  const b = dash.data.briefing;
  return (
    <Shell tab="status" title="דוח מצב" dash={dash}>
      <StatTiles b={b} />
      <BankTiles />
      <Briefing b={b} />
      {b?.salesWeek?.length ? (
        <div className="grid-2">
          <div><Sales /></div>
          <div><SalesWeek days={b.salesWeek} /></div>
        </div>
      ) : null}
      <Todo todo={b?.todo} />
      <p className="more"><Link href="/details" className="mp-chip">לפירוט המלא ←</Link></p>
    </Shell>
  );
}
