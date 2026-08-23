'use client';

import { useState } from 'react';

// First-run wizard. Shown instead of the dashboard until config/settings.json
// has an entityType. Secrets go straight to /api/setup, which stores them via
// scripts/lib/secrets.mjs (Keychain on a Mac, chmod-600 .env elsewhere) and
// never sends them back.
export default function Setup({ status, onDone }) {
  const [entityType, setEntityType] = useState(status?.entityType || '');
  const [advanceRatePct, setAdvance] = useState(status?.advanceRatePct ?? '');
  const [creditPoints, setCredit] = useState(status?.creditPoints ?? '');
  const [vatPeriod, setVatPeriod] = useState(status?.vatPeriodMonths == null ? 'auto' : String(status.vatPeriodMonths));
  const [vatDueDay, setVatDueDay] = useState(status?.vatDueDay ?? 15);
  const [financy, setFinancy] = useState({ clientId: '', clientSecret: '', userId: '' });
  const [useCardcom, setUseCardcom] = useState(!!status?.cardcomEnabled);
  const [cardcom, setCardcom] = useState({ apiName: '', apiPassword: '', productFieldId: status?.productFieldId ?? 24 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const hasFinancy = !!status?.hasFinancy;
  const hasCardcom = !!status?.hasCardcom;

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = {
        entityType, advanceRatePct, creditPoints, vatPeriodMonths: vatPeriod, vatDueDay,
        financy: financy.clientId || financy.clientSecret || financy.userId ? financy : null,
        cardcom: useCardcom ? cardcom : null,
      };
      const res = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'שגיאה');
      setResult(json);
      setFinancy({ clientId: '', clientSecret: '', userId: '' });
      setCardcom((c) => ({ ...c, apiName: '', apiPassword: '' }));
      const failed = Object.entries(json.sync || {}).filter(([, r]) => !r.ok);
      if (failed.length) {
        setError(failed.map(([k, r]) => `${k === 'financy' ? 'Financy' : 'קארדקום'}: ${r.err || r.out || 'נכשל'}`).join(' · '));
      } else {
        onDone?.();
      }
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  const field = (label, input, hint) => (
    <label className="su-field">
      <span className="su-label">{label}</span>
      {input}
      {hint ? <span className="su-hint">{hint}</span> : null}
    </label>
  );
  const inp = (props) => <input className="su-input" autoComplete="off" spellCheck={false} {...props} />;

  return (
    <section className="panel su">
      <div className="panel-head"><h2>הגדרה ראשונית</h2></div>
      <p className="su-intro">
        שלוש דקות ואתה בפנים. הכל נשמר מקומית במחשב הזה: המפתחות ב-Keychain (מק) או בקובץ מוגן,
        ושום דבר לא יוצא החוצה חוץ מהקריאות לבנק ולסליקה.
      </p>

      <form onSubmit={submit}>
        <h3 className="su-h">1 · העסק</h3>
        <div className="su-radios" role="radiogroup" aria-label="סוג עסק">
          {[['patur', 'עוסק פטור'], ['murshe', 'עוסק מורשה'], ['company', 'חברה בע"מ']].map(([v, l]) => (
            <button type="button" key={v} className={`mp-chip${entityType === v ? ' on' : ''}`} aria-pressed={entityType === v} onClick={() => setEntityType(v)}>{l}</button>
          ))}
        </div>
        <div className="su-grid">
          {field('שיעור מקדמות מס הכנסה (%)',
            inp({ type: 'number', step: '0.1', min: 0, max: 50, value: advanceRatePct, onChange: (e) => setAdvance(e.target.value), placeholder: 'למשל 5' }),
            'מופיע בפנקס המקדמות או אצל הרו"ח. לא יודע? השאר ריק והשלם אחר כך.')}
          {entityType !== 'company' ? field('נקודות זיכוי',
            inp({ type: 'number', step: '0.25', min: 0, max: 20, value: creditPoints, onChange: (e) => setCredit(e.target.value), placeholder: '2.25' }),
            'כל תושב מקבל לפחות 2.25. ריק = מינימום.') : null}
        </div>

        {entityType && entityType !== 'patur' ? (
          <>
            <div className="su-label" style={{ marginTop: 14 }}>דיווח מע"מ</div>
            <div className="su-radios" role="radiogroup" aria-label="תדירות דיווח מע״מ">
              {[['auto', 'לפי המחזור (אוטומטי)'], ['1', 'חודשי'], ['2', 'דו-חודשי']].map(([v, l]) => (
                <button type="button" key={v} className={`mp-chip${vatPeriod === v ? ' on' : ''}`} aria-pressed={vatPeriod === v} onClick={() => setVatPeriod(v)}>{l}</button>
              ))}
            </div>
            <div className="su-grid">
              {field('יום ההגשה בחודש העוקב',
                inp({ type: 'number', min: 1, max: 28, value: vatDueDay, onChange: (e) => setVatDueDay(e.target.value) }),
                'בדרך כלל 15. מדווחים בדיווח מפורט (874): 23. מחזור מעל ₪1,775,000 = חודשי.')}
            </div>
          </>
        ) : null}

        <h3 className="su-h">2 · בנק דרך Open Finance (Financy)</h3>
        {hasFinancy ? <p className="su-ok">מפתחות Financy כבר שמורים. מלא שוב רק כדי להחליף.</p> : null}
        <div className="su-grid">
          {field('Client ID', inp({ value: financy.clientId, onChange: (e) => setFinancy({ ...financy, clientId: e.target.value }) }))}
          {field('Client Secret', inp({ type: 'password', value: financy.clientSecret, onChange: (e) => setFinancy({ ...financy, clientSecret: e.target.value }) }))}
          {field('User ID', inp({ value: financy.userId, onChange: (e) => setFinancy({ ...financy, userId: e.target.value }) }))}
        </div>
        <p className="su-hint">נרשמים ב-Financy, מחברים את חשבונות הבנק דרך תקן הבנקאות הפתוחה, ומקבלים את שלושת המפתחות.</p>

        <h3 className="su-h">3 · סליקה בקארדקום <span className="su-opt">לא חובה</span></h3>
        <label className="su-check">
          <input type="checkbox" checked={useCardcom} onChange={(e) => setUseCardcom(e.target.checked)} />
          אני סולק דרך קארדקום ורוצה לראות מכירות בזמן אמת
        </label>
        {useCardcom ? (
          <>
            {hasCardcom ? <p className="su-ok">מפתחות קארדקום כבר שמורים. מלא שוב רק כדי להחליף.</p> : null}
            <div className="su-grid">
              {field('API Name', inp({ value: cardcom.apiName, onChange: (e) => setCardcom({ ...cardcom, apiName: e.target.value }) }))}
              {field('API Password', inp({ type: 'password', value: cardcom.apiPassword, onChange: (e) => setCardcom({ ...cardcom, apiPassword: e.target.value }) }))}
              {field('שדה שם המוצר', inp({ type: 'number', min: 1, max: 999, value: cardcom.productFieldId, onChange: (e) => setCardcom({ ...cardcom, productFieldId: e.target.value }) }), 'מספר ה-CustomField בעסקה. ברירת מחדל 24.')}
            </div>
            <p className="su-hint">בממשק קארדקום: הגדרות → משתמשי API → משתמש חדש עם הרשאת קריאה בלבד.</p>
          </>
        ) : null}

        {error ? <div className="su-err">{error}</div> : null}
        {result && !error ? <div className="su-ok">נשמר. טוען את הדשבורד…</div> : null}

        <div className="su-actions">
          <button type="submit" className="su-btn" disabled={busy || !entityType}>
            {busy ? 'שומר ומושך נתונים… (דקה-שתיים)' : 'שמור ופתח את הדשבורד'}
          </button>
          {status?.configured ? <button type="button" className="mp-chip" onClick={() => onDone?.()}>חזרה בלי שינוי</button> : null}
        </div>
      </form>
    </section>
  );
}
