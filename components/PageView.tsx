'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { PageData, PendingOp, PendingSet, Segment } from '@/lib/types';
import Md from './Md';
import PlaceDialog, { titleOf } from './PlaceDialog';
import { usePages } from './WikiContext';
import { joinSummary, splitSummary } from '@/lib/summary';
import SourceChip from './SourceChip';
import { markTableRows, markWords, rehypeMarks } from './wordMarks';

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
      const m = markTableRows(r, added[i]) ?? markWords(r, added[i]);
      if (m) {
        removed[i] = m.removed;
        added[i] = m.added;
        marked = true;
      }
    });
  }
  return { removed: removed.join('\n\n'), added: added.join('\n\n'), marked };
}

// Tab text for a suggestion; when two share a summary, the file or person tells them apart
function tabLabel(p: PendingSet, all: PendingSet[]): string {
  const short = (t: string, n: number) => (t.length > n ? t.slice(0, n) + '...' : t);
  const twin = all.some((o) => o !== p && o.summary === p.summary);
  if (!twin || !p.source) return short(p.summary, 36);
  const from = p.source.kind === 'file' ? p.source.filename : p.source.user;
  return `${short(p.summary, 24)} (${short(from ?? '', 20)})`;
}

// A suggestion to move or remove the whole page
function OpCard({ op, busy, decide }: { op: PendingOp; busy: boolean; decide: (action: 'approve' | 'reject') => void }) {
  return (
    <div className={'review op-card' + (op.stale ? ' conflict' : '')}>
      <div className="review-head">
        <div>
          <div className="review-title">{op.summary}</div>
          <div className="small-text">
            {op.kind === 'move' ? (
              <>
                Suggested move to <strong>{op.newPath}</strong>. Pages under it move too, and links to it are updated.
              </>
            ) : (
              'Suggested removal of this page.'
            )}{' '}
            <SourceChip source={op.source} />
          </div>
          {op.stale && <div className="muted small-text">{op.stale} It can no longer be applied.</div>}
        </div>
        <div className="actions">
          {!op.stale && (
            <button className="btn approve" disabled={busy} onClick={() => decide('approve')}>
              {op.kind === 'move' ? 'Approve move' : 'Approve removal'}
            </button>
          )}
          <button className="btn reject" disabled={busy} onClick={() => decide('reject')}>
            Reject
          </button>
        </div>
      </div>
    </div>
  );
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
        <SourceChip source={set.source} earlier={set.earlierSources} also={set.alsoSources} />
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
        <div className={'removed' + (text.marked ? ' has-marks' : '')} aria-label="Text to be removed">
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
  onDropFiles,
}: {
  path: string;
  user: string;
  version: number;
  onChanged: () => void;
  onDropFiles?: (files: File[]) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const dropProps = onDropFiles
    ? {
        onDragOver: (e: React.DragEvent) => {
          if (!Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        },
        onDragLeave: (e: React.DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        },
        onDrop: (e: React.DragEvent) => {
          if (!Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          setDragging(false);
          onDropFiles(Array.from(e.dataTransfer.files));
        },
      }
    : {};
  const router = useRouter();
  const [data, setData] = useState<PageData | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // The summary is edited in its own box, so it can be changed but not dropped by accident
  const [summaryDraft, setSummaryDraft] = useState('');
  const [hadSummary, setHadSummary] = useState(false);
  const [moving, setMoving] = useState(false);
  const pages = usePages();
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
      await load(); // reload first: a successful load clears the error
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function startEdit(title?: string) {
    if (!data) return;
    const split = data.exists ? splitSummary(data.content) : { summary: null, rest: `# ${title || data.title}\n\n` };
    setDraft(split.rest);
    setSummaryDraft(split.summary ?? '');
    setHadSummary(!!split.summary);
    setEditing(true);
  }

  // A page just named in New page opens straight in the editor with its title
  useEffect(() => {
    if (!data || data.exists || data.path !== path) return;
    try {
      const fresh = JSON.parse(sessionStorage.getItem('wiki-new-page') || 'null');
      if (fresh?.path === path) {
        sessionStorage.removeItem('wiki-new-page');
        startEdit(fresh.title);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, path]);

  const summaryNote = !summaryDraft.trim()
    ? hadSummary
      ? 'The summary can be changed but not removed.'
      : !data?.exists
        ? 'A new page needs a summary.'
        : ''
    : '';

  async function save() {
    await guarded(async () => {
      const r = await fetch('/api/page', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: summaryDraft.trim() ? joinSummary(draft, summaryDraft) : draft, user }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Save failed');
      setEditing(false);
    });
  }

  async function move(to: string, title: string) {
    setMoving(false);
    await guarded(async () => {
      const d = await post('/api/page/move', { from: path, to, title, user });
      router.push(`/wiki/${d.path}`);
    });
  }

  async function remove() {
    if (!window.confirm('Delete this page? Earlier versions are kept and can be restored.')) return;
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
    <main className={'page' + (dragging ? ' dragging' : '')} {...dropProps}>
      {dragging && <div className="drop-hint page-drop">Drop files to add them to this page</div>}
      <nav className="crumbs" aria-label="Where this page is">
        {data.path === 'index' ? (
          'Home'
        ) : (
          <>
            <Link href="/wiki/index">Home</Link>
            {data.path.split('/').map((_, i, parts) => {
              const p = parts.slice(0, i + 1).join('/');
              return (
                <span key={p}>
                  {' › '}
                  {i < parts.length - 1 ? <Link href={`/wiki/${p}`}>{titleOf(pages, p)}</Link> : data.title}
                </span>
              );
            })}
          </>
        )}
      </nav>
      {moving && (
        <PlaceDialog
          mode="move"
          page={path}
          initialTitle={data.title}
          initialParent={path.split('/').slice(0, -1).join('/')}
          busy={busy}
          onCancel={() => setMoving(false)}
          onDone={move}
        />
      )}
      <div className="title-row">
        <h1 className="doc-title">{data.title}</h1>
        {!editing && data.exists && (
          <div className="actions">
            <button className="btn" onClick={() => startEdit()}>
              Edit
            </button>
            {data.path !== 'index' && (
              <button className="btn quiet" onClick={() => setMoving(true)}>
                Move
              </button>
            )}
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
          <label className="field summary-field">
            <span>Summary</span>
            <textarea
              value={summaryDraft}
              onChange={(e) => setSummaryDraft(e.target.value)}
              rows={2}
              spellCheck
              placeholder="One or two sentences on what this page covers. It shows at the top of the page and on the structure page."
            />
            {summaryNote && <span className="small-text field-note">{summaryNote}</span>}
          </label>
          <label className="field">
            <span>Page</span>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck autoFocus />
          </label>
          <div className="editor-bar">
            <button className="btn primary" disabled={busy || !!summaryNote} onClick={save}>
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
          {data.ops.map((op) => (
            <OpCard
              key={op.opId}
              op={op}
              busy={busy}
              decide={(action) =>
                guarded(async () => {
                  const d = await post(`/api/ops/${op.opId}`, { action, user });
                  if (action === 'approve') router.push(d.path ? `/wiki/${d.path}` : '/wiki/index');
                })
              }
            />
          ))}

          {data.pending.length > 0 && set && (
            <div className={'review' + (set.conflict ? ' conflict' : '')}>
              {data.pending.length > 1 && (
                <div className="tabs" role="tablist">
                  {data.pending.map((p, i) => (
                    <button key={p.proposalId} role="tab" aria-selected={i === setIdx} className={'tab' + (i === setIdx ? ' on' : '')} onClick={() => setSetIdx(i)}>
                      {tabLabel(p, data.pending)}
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
              <Summarised content={data.content} />
            ) : (
              <div className="empty">
                <p>{data.children.length ? 'This section has no page of its own yet.' : 'This page does not exist yet.'}</p>
                <button className="btn primary" onClick={() => startEdit()}>
                  Create page
                </button>
              </div>
            )}
          </article>

          {data.children.length > 0 && (
            <nav className="subpages" aria-label="Sub-pages">
              <h2>Sub-pages</h2>
              <ul>
                {data.children.map((c) => (
                  <li key={c.path}>
                    <Link href={`/wiki/${c.path}`}>{c.title}</Link>
                    {c.below > 0 && (
                      <span className="muted small-text">
                        {' '}
                        and {c.below} page{c.below > 1 ? 's' : ''} under it
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          )}

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

// The page with its summary shown apart at the top
function Summarised({ content }: { content: string }) {
  const { summary, rest } = splitSummary(content);
  return (
    <>
      {summary && (
        <div className="page-summary">
          <Md>{summary}</Md>
        </div>
      )}
      <Md>{rest}</Md>
    </>
  );
}
