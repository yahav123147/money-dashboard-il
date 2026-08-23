'use client';

import { useDashboard } from '@/components/useDashboard';
import Shell from '@/components/Shell';
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
import Bottomline from '@/components/Bottomline';
import MonthPicker from '@/components/MonthPicker';
import TaxView from '@/components/TaxView';
import Quality from '@/components/Quality';
import Review from '@/components/Review';

// Details screen: "why, and what happened this month?" Three sections.
// The month picker drives the first section only.
const ENDPOINTS = ['overview', 'pnl', 'advances', 'cashflow', 'expenses', 'tax', 'vat', 'advances-ytd'];

function Section({ id, title, sub, children }) {
  return (
    <section className="sect" id={id}>
      <div className="sect-head"><h2>{title}</h2>{sub ? <span className="sect-sub">{sub}</span> : null}</div>
      {children}
    </section>
  );
}

export default function DetailsPage() {
  const dash = useDashboard(ENDPOINTS);
  const { data, selMonth, monthList, partialMonth, setMonth } = dash;
  const { overview, pnl, advances, cashflow, expenses, tax, vat } = data;
  const advancesYtd = data['advances-ytd'];

  return (
    <Shell tab="details" title="פירוט" dash={dash}>
      <Section id="month" title="החודש" sub="בורר החודש משפיע על הקטע הזה בלבד">
        <MonthPicker months={monthList} value={selMonth} partial={partialMonth} onChange={setMonth} />
        <Bottomline pnl={pnl} advances={advances} month={selMonth} />
        <Channels month={selMonth} />
        <PnlTable pnl={pnl} month={selMonth} />
        <Expenses expenses={expenses} month={selMonth} />
      </Section>

      <Section id="tax" title="מסים">
        <div className="grid-3">
          <div className="g3-cell"><VatPanel vat={vat} /></div>
          <div className="g3-cell"><AdvancesGauge advances={advances} /></div>
          <div className="g3-cell"><AdvancesYtd ytd={advancesYtd} /></div>
        </div>
        <TaxView tax={tax} />
      </Section>

      <Section id="cash" title="תזרים ונזילות" sub="עדכני להיום">
        <Hero overview={overview} />
        <div className="grid-2">
          <div><Cashflow cashflow={cashflow} /></div>
          <div><AccountsCard overview={overview} /></div>
        </div>
        <div className="grid-2" id="reconcile">
          <div><Sales /></div>
          <div><Reconcile /></div>
        </div>
      </Section>

      <Section id="trust" title="אמינות הנתונים" sub="מה יכול להטות את המספרים למעלה, ומה הסוכן הפיננסי אמר על זה">
        <div className="grid-2">
          <div><Quality /></div>
          <div><Review /></div>
        </div>
      </Section>
    </Shell>
  );
}
