'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

type Node = { path: string; title: string; exists: boolean; summary: string | null; pages: number; children: Node[] };
type Data = { home: { title: string; summary: string | null } | null; sections: Node[]; pending: Record<string, number> };

// The wiki's structure, generated from the pages so it is always current. Only the summaries are
// written by people (or suggested by the librarian); the arrangement comes from where pages are.
export default function StructureView({ user, version, onChanged }: { user: string; version: number; onChanged: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/structure', { cache: 'no-store' });
      setData(await r.json());
    } catch {
      setError('Could not load the structure.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, version]);

  return (
    <main className="page structure">
      <div className="crumbs">Wiki structure</div>
      <div className="title-row">
        <h1 className="doc-title">Structure</h1>
      </div>
      <p className="muted small-text">
        Every section and page, arranged as they are in the wiki. This page builds itself from the pages, so it is always up to date. Each
        section&apos;s summary says what belongs in it; the librarian and filing use the summaries to decide where new information goes.
      </p>
      {error && <div className="error">{error}</div>}
      {!data ? (
        !error && <p className="muted small-text">Loading</p>
      ) : data.sections.length === 0 ? (
        <p className="muted">The wiki only has its home page so far.</p>
      ) : (
        <ul className="struct">
          {data.sections.map((n) => (
            <Branch key={n.path} node={n} pending={data.pending} user={user} onSaved={() => (load(), onChanged())} />
          ))}
        </ul>
      )}
    </main>
  );
}

function Branch({ node, pending, user, onSaved }: { node: Node; pending: Record<string, number>; user: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isSection = node.children.length > 0 || !node.path.includes('/');
  const waiting = pending[node.path] ?? 0;
  const leaves = node.children.filter((c) => !c.children.length);
  const branches = node.children.filter((c) => c.children.length);

  async function save() {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/structure', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: node.path, summary: draft, user }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not save the summary.');
      setEditing(false);
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={'struct-node' + (isSection ? ' section' : '')}>
      <div className="struct-head">
        <Link href={`/wiki/${node.path}`} className="struct-title">
          {node.title}
        </Link>
        {node.children.length > 0 && <span className="muted small-text">{node.pages} pages</span>}
        {waiting > 0 && (
          <Link href={`/wiki/${node.path}`} className="badge" title="Suggestions waiting for review on this page">
            {waiting}
          </Link>
        )}
        {isSection && !editing && (
          <button
            className="btn small quiet"
            onClick={() => {
              setDraft(node.summary ?? '');
              setEditing(true);
            }}
          >
            Edit summary
          </button>
        )}
      </div>
      {editing ? (
        <div className="struct-edit">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus aria-label={`Summary of ${node.title}`} />
          <div className="editor-bar">
            <button className="btn primary small" disabled={busy || !draft.trim()} onClick={save}>
              Save summary
            </button>
            <button className="btn quiet small" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <span className="muted small-text">One or two sentences on what belongs here. Saving publishes it right away under {user}.</span>
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      ) : (
        isSection &&
        (node.summary ? <p className="struct-summary">{node.summary}</p> : <p className="struct-summary missing">No summary yet.</p>)
      )}
      {leaves.length > 0 && (
        <div className="struct-pages small-text">
          {leaves.map((l, i) => (
            <span key={l.path}>
              {i > 0 && ', '}
              <Link href={`/wiki/${l.path}`}>{l.title}</Link>
              {(pending[l.path] ?? 0) > 0 && <span className="muted"> ({pending[l.path]} waiting)</span>}
            </span>
          ))}
        </div>
      )}
      {branches.length > 0 && (
        <ul className="struct">
          {branches.map((b) => (
            <Branch key={b.path} node={b} pending={pending} user={user} onSaved={onSaved} />
          ))}
        </ul>
      )}
    </li>
  );
}
