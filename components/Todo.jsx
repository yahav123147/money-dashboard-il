// "לטיפול" as three equal columns: today · this week · when you have time.
// A column with nothing in it says so, quietly. Only "today" carries the
// action color; chores never do.
const GROUPS = [
  { key: 'today', label: 'היום', tone: 'action', empty: 'כלום' },
  { key: 'week', label: 'השבוע', tone: 'attention', empty: 'כלום' },
  { key: 'later', label: 'כשיהיה לך זמן', tone: 'plain', empty: 'הכל מסודר' },
];

export default function Todo({ todo }) {
  const t = todo || { today: [], week: [], later: [] };
  const quiet = !t.today?.length && !t.week?.length;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>לטיפול</h2>
        {quiet ? <div className="side"><span className="todo-quiet">אין מה לטפל היום.</span></div> : null}
      </div>
      <div className="todo-cols">
        {GROUPS.map((g) => {
          const items = Array.isArray(t[g.key]) ? t[g.key] : [];
          return (
            <div className={`todo-col tone-${g.tone}`} key={g.key}>
              <div className="todo-head"><span className="brief-dot" />{g.label}<span className="todo-count">{items.length || ''}</span></div>
              {items.length === 0 ? <div className="todo-empty">{g.empty}</div> : items.map((it, i) => (
                <div className="todo-item" key={`${it.key}-${i}`}>
                  <div className="todo-text">{it.text}</div>
                  {it.action ? <div className="todo-action">{it.action}</div> : null}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
