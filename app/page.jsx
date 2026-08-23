'use client';

import Link from 'next/link';
import { useDashboard } from '@/components/useDashboard';
import Shell from '@/components/Shell';
import Briefing from '@/components/Briefing';
import Todo from '@/components/Todo';
import SalesWeek from '@/components/SalesWeek';

// Status screen: "what is the situation, and what do I do today?"
// No month picker, no tables. Reads in ten seconds.
const ENDPOINTS = ['briefing'];

export default function StatusPage() {
  const dash = useDashboard(ENDPOINTS);
  const b = dash.data.briefing;
  return (
    <Shell tab="status" title="דוח מצב" dash={dash}>
      <Briefing b={b} />
      <div className="grid-2">
        <div><Todo todo={b?.todo} /></div>
        <div>{b?.salesWeek?.length ? <SalesWeek days={b.salesWeek} /> : null}</div>
      </div>
      <p className="more"><Link href="/details" className="mp-chip">לפירוט המלא ←</Link></p>
    </Shell>
  );
}
