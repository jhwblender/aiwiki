'use client';
import { useEffect, useRef, useState } from 'react';

type Entry = { kind: 'group' | 'user'; subject: string; level: string };
type Loaded = {
  rules: { everyone: string; entries: Entry[] } | null;
  followsFrom: string | null;
  groups: { id: number; name: string }[];
  people: { name: string; display: string }[];
};

const LEVELS = [
  { id: 'read', label: 'Can read' },
  { id: 'edit', label: 'Can edit' },
  { id: 'approve', label: 'Can approve' },
  { id: 'manage', label: 'Can manage' },
];
const EVERYONE = [
  { id: 'role', label: 'Same as their role' },
  { id: 'none', label: 'No access' },
  { id: 'read', label: 'Can read' },
  { id: 'edit', label: 'Can edit' },
  { id: 'approve', label: 'Can approve' },
];

// Who can use a page and everything under it. The first rules start with everyone else keeping
// what their role gives, so adding one person never locks the rest out by accident.
export default function AccessDialog({ path, title, onClose, onSaved }: { path: string; title: string; onClose: () => void; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<Loaded | null>(null);
  const [everyone, setEveryone] = useState('role');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
    fetch('/api/access?path=' + encodeURIComponent(path), { cache: 'no-store' })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not load who has access.');
        setData(d);
        setEveryone(d.rules?.everyone ?? 'role');
        setEntries(d.rules?.entries ?? []);
      })
      .catch((e) => setError(e.message));
  }, [path]);

  const nameOf = (e: Entry) =>
    e.kind === 'group'
      ? `${data?.groups.find((g) => String(g.id) === e.subject)?.name ?? 'Removed group'} (group)`
      : (data?.people.find((p) => p.name === e.subject)?.display ?? e.subject);
  const taken = (kind: string, subject: string) => entries.some((e) => e.kind === kind && e.subject === subject);

  function add() {
    const [kind, ...rest] = adding.split(':');
    if (!rest.length) return;
    setEntries([...entries, { kind: kind as Entry['kind'], subject: rest.join(':'), level: 'read' }]);
    setAdding('');
  }

  async function save(rules: { everyone: string; entries: Entry[] } | null) {
    setBusy(true);
    setError('');
    const r = await fetch('/api/access', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, rules }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setError(d.error || 'Could not save.');
    onSaved();
  }

  return (
    <dialog ref={dialog} className="place-dialog" onClose={onClose}>
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ everyone, entries });
        }}
      >
        <h2>Who can use {title}</h2>
        <p className="muted small-text">
          These rules also cover every page under this one, unless a page below has rules of its own. Admins can always get in.
        </p>
        {data && !data.rules && (
          <p className="small-text">
            {data.followsFrom ? `This page currently follows the rules on ${data.followsFrom === '*' ? 'the whole wiki' : data.followsFrom}.` : 'This page currently follows each person’s role.'}
          </p>
        )}
        {data && (
          <>
            <ul className="access-list">
              {entries.map((e) => (
                <li key={e.kind + e.subject} className="access-row">
                  <span className="access-who">{nameOf(e)}</span>
                  <select
                    aria-label={`Level for ${nameOf(e)}`}
                    value={e.level}
                    onChange={(ev) => setEntries(entries.map((o) => (o === e ? { ...o, level: ev.target.value } : o)))}
                  >
                    {LEVELS.map((l) => (
                      <option key={l.id} value={l.id}>{l.label}</option>
                    ))}
                  </select>
                  <button type="button" className="btn small quiet" onClick={() => setEntries(entries.filter((o) => o !== e))}>
                    Remove
                  </button>
                </li>
              ))}
              <li className="access-row">
                <span className="access-who">Everyone else</span>
                <select aria-label="Level for everyone else" value={everyone} onChange={(e) => setEveryone(e.target.value)}>
                  {EVERYONE.map((l) => (
                    <option key={l.id} value={l.id}>{l.label}</option>
                  ))}
                </select>
              </li>
            </ul>
            <div className="access-add">
              <select aria-label="Group or person to add" value={adding} onChange={(e) => setAdding(e.target.value)}>
                <option value="">Add a group or person</option>
                <optgroup label="Groups">
                  {data.groups.filter((g) => !taken('group', String(g.id))).map((g) => (
                    <option key={g.id} value={`group:${g.id}`}>{g.name}</option>
                  ))}
                </optgroup>
                <optgroup label="People">
                  {data.people.filter((p) => !taken('user', p.name)).map((p) => (
                    <option key={p.name} value={`user:${p.name}`}>{p.display}</option>
                  ))}
                </optgroup>
              </select>
              <button type="button" className="btn small" disabled={!adding} onClick={add}>
                Add
              </button>
            </div>
          </>
        )}
        {error && <p className="login-error">{error}</p>}
        <div className="dialog-actions">
          <button className="btn primary" disabled={busy || !data}>
            Save access
          </button>
          {data?.rules && (
            <button type="button" className="btn quiet" disabled={busy} onClick={() => save(null)}>
              Remove these rules
            </button>
          )}
          <button type="button" className="btn quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
