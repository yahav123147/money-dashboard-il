// "לטיפול": three groups. Items are sentences with the concrete action under
// them. Chores never get the action color; only money missing / deadline
// passed lives in "היום".
const GROUPS = [
  { key: 'today', label: 'היום', tone: 'action' },
  { key: 'week', label: 'השבוע', tone: 'attention' },
  { key: 'later', label: 'כשיהיה לך זמן', tone: 'plain' },
];

export default function Todo({ todo }) {
  const t = todo || { today: [], week: [], later: [] };
  const quiet = !t.today.length && !t.week.length;
  return (
    <section className="panel">
      <div className="panel-head"><h2>לטיפול</h2></div>
      {quiet ? <p className="todo-quiet">אין מה לטפל היום.</p> : null}
      {GROUPS.map((g) => {
        const items = Array.isArray(t[g.key]) ? t[g.key] : [];
        if (!items.length) return null;
        return (
          <div className={`todo-group tone-${g.tone}`} key={g.key}>
            <div className="todo-head"><span className="brief-dot" />{g.label}</div>
            {items.map((it, i) => (
              <div className="todo-item" key={`${it.key}-${i}`}>
                <div className="todo-text">{it.text}</div>
                {it.action ? <div className="todo-action">{it.action}</div> : null}
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}
