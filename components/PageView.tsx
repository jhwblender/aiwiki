'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PageData, PendingSet, Segment } from '@/lib/types';
import Md from './Md';
import SourceChip from './SourceChip';
import { markWords, rehypeMarks } from './wordMarks';

const insMarks = [rehypeMarks('word-ins')];
const delMarks = [rehypeMarks('word-del')];

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}

// When an edit swaps paragraphs one for one, mark the changed words in each pair.
function pairMarks(seg: Extract<Segment, { type: 'change' }>) {
  const removed = [...seg.removed];
  const added = [...seg.added];
  let marked = false;
  if (removed.length === added.length) {
    removed.forEach((r, i) => {
      const m = markWords(r, added[i]);
      if (m) {
        removed[i] = m.removed;
        added[i] = m.added;
        marked = true;
      }
    });
  }
  return { removed: removed.join('\n\n'), added: added.join('\n\n'), marked };
}

function Hunk({
  seg,
  set,
  busy,
  showActions,
  decide,
}: {
  seg: Extract<Segment, { type: 'change' }>;
  set: PendingSet;
  busy: boolean;
  showActions: boolean;
  decide: (action: 'approve' | 'reject') => void;
}) {
  const kind = seg.removed.length && seg.added.length ? 'Edit' : seg.added.length ? 'Addition' : 'Removal';
  const text = pairMarks(seg);
  return (
    <section className="hunk">
      <header className="hunk-bar">
        <span className="hunk-kind">{set.isNew ? 'New page' : kind} by AI</span>
        <SourceChip source={set.source} />
        {showActions && (
          <span className="hunk-actions">
            <button className="btn approve small" disabled={busy} onClick={() => decide('approve')}>
              Approve
            </button>
            <button className="btn reject small" disabled={busy} onClick={() => decide('reject')}>
              Reject
            </button>
          </span>
        )}
      </header>
      {seg.removed.length > 0 && (
        <div className="removed" aria-label="Text to be removed">
          <Md rehypePlugins={text.marked ? delMarks : undefined}>{text.removed}</Md>
        </div>
      )}
      {seg.added.length > 0 && (
        <div className="added" aria-label="Text to be added">
          <Md rehypePlugins={text.marked ? insMarks : undefined}>{text.added}</Md>
        </div>
      )}
    </section>
  );
}

export default function PageView({
  path,
  user,
  version,
  onChanged,
}: {
  path: string;
  user: string;
  version: number;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<PageData | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [setIdx, setSetIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const r = await fetch('/api/page?path=' + encodeURIComponent(path), { cache: 'no-store' });
    const d = await r.json();
    if (!r.ok) {
      setError(d.error || 'Could not load page');
      return;
    }
    setError('');
    setData(d);
    setSetIdx((i) => Math.min(i, Math.max(0, d.pending.length - 1)));
  }, [path]);

  useEffect(() => {
    setEditing(false);
    setSetIdx(0);
    setData(null);
  }, [path]);

  useEffect(() => {
    load();
  }, [load, version]);

  async function guarded(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
      onChanged();
    } catch (e: any) {
      setError(e.message);
      await load();
    } finally {
      setBusy(false);
    }
  }

  function startEdit() {
    if (!data) return;
    setDraft(data.exists ? data.content : `# ${data.title}\n\n`);
    setEditing(true);
  }

  async function save() {
    await guarded(async () => {
      const r = await fetch('/api/page', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: draft, user }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Save failed');
      setEditing(false);
    });
  }

  async function remove() {
    if (!window.confirm('Delete this page? The history stays in git.')) return;
    await guarded(async () => {
      const r = await fetch(`/api/page?path=${encodeURIComponent(path)}&user=${encodeURIComponent(user)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error || 'Delete failed');
      router.push('/wiki/index');
    });
  }

  if (error && !data) return <main className="page"><div className="error">{error}</div></main>;
  if (!data) return <main className="page"><div className="muted">Loading</div></main>;

  const set = data.pending[setIdx];
  const changeCount = set ? set.segments.filter((s) => s.type === 'change').length : 0;
  const pendingNew = !data.exists && data.pending.length > 0;
  const resolveAll = (action: 'approve' | 'reject') =>
    guarded(() => post(`/api/proposals/${set!.proposalId}/resolve`, { action, user }));

  return (
    <main className="page">
      <div className="crumbs">{data.path.split('/').join(' / ')}</div>
      <div className="title-row">
        <h1 className="doc-title">{data.title}</h1>
        {!editing && !pendingNew && (
          <div className="actions">
            <button className="btn" onClick={startEdit}>
              {data.exists ? 'Edit' : 'Create page'}
            </button>
            {data.exists && (
              <button className="btn quiet" onClick={remove}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      {editing ? (
        <div className="editor">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck autoFocus />
          <div className="editor-bar">
            <button className="btn primary" disabled={busy} onClick={save}>
              Save page
            </button>
            <button className="btn quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <span className="muted small-text">
              Saved edits publish right away under {user}. Use # for headings, - for lists and [[page/path]] to link a page.
            </span>
          </div>
        </div>
      ) : (
        <>
          {data.pending.length > 0 && set && (
            <div className={'review' + (set.conflict ? ' conflict' : '')}>
              {data.pending.length > 1 && (
                <div className="tabs" role="tablist">
                  {data.pending.map((p, i) => (
                    <button key={p.proposalId} role="tab" aria-selected={i === setIdx} className={'tab' + (i === setIdx ? ' on' : '')} onClick={() => setSetIdx(i)}>
                      {p.summary.length > 36 ? p.summary.slice(0, 36) + '...' : p.summary}
                    </button>
                  ))}
                </div>
              )}
              <div className="review-head">
                <div>
                  <div className="review-title">{set.summary}</div>
                  <div className="muted small-text">
                    {set.conflict
                      ? 'The page was edited in the same place after this was suggested, so it can no longer be applied. Reject it and ask the assistant again if it is still needed.'
                      : set.isNew
                      ? 'Suggested new page. It is not published until approved.'
                      : `${changeCount} suggested change${changeCount > 1 ? 's' : ''}. Nothing here is published until approved.`}
                  </div>
                </div>
                <div className="actions">
                  {!set.conflict && (
                    <button className="btn approve" disabled={busy} onClick={() => resolveAll('approve')}>
                      {changeCount > 1 ? 'Approve all' : 'Approve'}
                    </button>
                  )}
                  <button className="btn reject" disabled={busy} onClick={() => resolveAll('reject')}>
                    {changeCount > 1 && !set.conflict ? 'Reject all' : 'Reject'}
                  </button>
                </div>
              </div>
              {set.conflict && (
                <div className="doc conflict-preview">
                  {set.segments.map((s) =>
                    s.type === 'change' ? (
                      <Hunk key={s.index} seg={s} set={set} busy={busy} showActions={false} decide={() => {}} />
                    ) : null,
                  )}
                </div>
              )}
            </div>
          )}

          <article className="doc">
            {set && !set.conflict ? (
              set.segments.map((s, i) =>
                s.type === 'same' ? (
                  <Md key={i}>{s.blocks.join('\n\n')}</Md>
                ) : (
                  <Hunk
                    key={`${set.proposalId}-${s.index}-${s.fp}`}
                    seg={s}
                    set={set}
                    busy={busy}
                    showActions={changeCount > 1}
                    decide={(action) => guarded(() => post(`/api/proposals/${set.proposalId}/hunk`, { hunk: s.index, fp: s.fp, action, user }))}
                  />
                ),
              )
            ) : data.exists ? (
              <Md>{data.content}</Md>
            ) : (
              <div className="empty">
                <p>This page does not exist yet.</p>
                <button className="btn primary" onClick={startEdit}>
                  Create page
                </button>
              </div>
            )}
          </article>

          {data.sources.length > 0 && (
            <footer className="sources">
              <h2>Sources</h2>
              <ul>
                {data.sources.map((s) => (
                  <li key={s.source.id}>
                    <SourceChip source={s.source} />
                    <span className="muted small-text">approved by {s.approvedBy}</span>
                  </li>
                ))}
              </ul>
            </footer>
          )}
        </>
      )}
    </main>
  );
}
