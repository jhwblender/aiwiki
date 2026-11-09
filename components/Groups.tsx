'use client';
import { useCallback, useEffect, useState } from 'react';
import AccessDialog from './AccessDialog';

type Group = { id: number; name: string; parentId: number | null; members: string[] };
type Person = { name: string; display: string };

// Groups form a tree: someone in a group also counts as being in every group above it. Only admins
// see this; the page-by-page rules that use these groups are set from each page's Access button.
export default function Groups() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [error, setError] = useState('');
  const [wholeWiki, setWholeWiki] = useState(false);

  const load = useCallback(() => {
    fetch('/api/groups', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setGroups(d.groups);
        setPeople(d.people);
      })
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function act(method: 'POST' | 'PATCH' | 'DELETE', body?: object, param = '') {
    setError('');
    const r = await fetch('/api/groups' + param, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setError(d.error || 'That did not work.');
    load();
    return r.ok;
  }

  if (!groups) return null;

  // Parents before their children, each indented by how deep it sits
  const tree: { group: Group; depth: number }[] = [];
  const walk = (parentId: number | null, depth: number) => {
    for (const g of groups.filter((o) => o.parentId === parentId)) {
      tree.push({ group: g, depth });
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);

  // A group cannot move inside itself or one of its own sub-groups
  const below = (id: number): number[] => groups.filter((g) => g.parentId === id).flatMap((g) => [g.id, ...below(g.id)]);

  return (
    <section className="card">
      <h2>Groups</h2>
      <p className="muted small-text">
        Put people in groups, then use the Access button on any page to say which groups can read, edit, approve or manage it and
        everything under it. Someone in a group also counts as being in every group above it.
      </p>
      <button className="btn small" onClick={() => setWholeWiki(true)}>
        Access for the whole wiki
      </button>
      {wholeWiki && <AccessDialog path="*" title="the whole wiki" onClose={() => setWholeWiki(false)} onSaved={() => setWholeWiki(false)} />}
      {tree.length > 0 && (
        <ul className="group-list">
          {tree.map(({ group: g, depth }) => {
            const off = new Set([g.id, ...below(g.id)]);
            return (
              <li key={g.id} className="group-item" style={{ marginLeft: Math.min(depth, 4) * 16 }}>
                <details>
                  <summary>
                    {g.name} <span className="muted small-text">({g.members.length})</span>
                  </summary>
                  <div className="group-members">
                    {people.map((p) => (
                      <label key={p.name} className="small-text">
                        <input
                          type="checkbox"
                          checked={g.members.includes(p.name)}
                          onChange={(e) => act('PATCH', { id: g.id, members: e.target.checked ? [...g.members, p.name] : g.members.filter((m) => m !== p.name) })}
                        />
                        {p.display}
                      </label>
                    ))}
                  </div>
                  <div className="access-row">
                    <label className="small-text">
                      Inside{' '}
                      <select value={g.parentId ?? ''} onChange={(e) => act('PATCH', { id: g.id, parentId: e.target.value || null })}>
                        <option value="">Nothing (top level)</option>
                        {groups.filter((o) => !off.has(o.id)).map((o) => (
                          <option key={o.id} value={o.id}>{o.name}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="btn small quiet"
                      onClick={() => {
                        const next = window.prompt('New name for this group', g.name);
                        if (next && next.trim() !== g.name) void act('PATCH', { id: g.id, name: next });
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="btn small reject"
                      onClick={() => {
                        if (window.confirm(`Delete the group ${g.name}? Sections that only let this group in stay closed until someone sets new rules.`)) void act('DELETE', undefined, `?id=${g.id}`);
                      }}
                    >
                      Delete group
                    </button>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      <div className="access-add">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New group name" aria-label="New group name" />
        <select aria-label="Put the new group inside" value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">Top level</option>
          {tree.map(({ group: g }) => (
            <option key={g.id} value={g.id}>Inside {g.name}</option>
          ))}
        </select>
        <button
          className="btn primary"
          disabled={!name.trim()}
          onClick={async () => {
            if (await act('POST', { name, parentId: parent || null })) {
              setName('');
              setParent('');
            }
          }}
        >
          Add group
        </button>
      </div>
      {error && <span className="login-error">{error}</span>}
    </section>
  );
}
