'use client';

import Link from 'next/link';
import Setup from './Setup';

// Page chrome shared by the two screens: masthead with the two tabs, the
// first-run setup gate, and the footer.
export default function Shell({ tab, title, dash, children }) {
  const { setup, showSetup, setShowSetup, loadSetup, fetchAll, lastFetch } = dash;
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
          <h1>{title}</h1>
        </div>
        <div className="meta">
          <nav className="tabs" aria-label="מסכים">
            <Link href="/" className={`tab${tab === 'status' ? ' on' : ''}`}>דוח מצב</Link>
            <Link href="/details" className={`tab${tab === 'details' ? ' on' : ''}`}>פירוט</Link>
          </nav>
        </div>
      </header>
      <div className="metaline">
        <span>{today}</span>
        <span className="sep" />
        {lastFetch
          ? <span className="upd"><i />עודכן {lastFetch.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}</span>
          : <span>טוען…</span>}
        <span className="sep" />
        <button type="button" className="linkish" onClick={() => setShowSetup(true)}>הגדרות</button>
      </div>
      {children}
      <footer>מקומי בלבד · הנתונים לא יוצאים מהמחשב שלך</footer>
    </main>
  );
}
