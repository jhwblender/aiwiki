'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { PageData, PendingOp, PendingSet, Segment } from '@/lib/types';
import Md from './Md';
import PlaceDialog, { titleOf } from './PlaceDialog';
import LinkDialog from './LinkDialog';
import Contents from './Contents';
import PageHistory from './PageHistory';
import AccessDialog from './AccessDialog';
import { usePages } from './WikiContext';
import { joinSummary, splitSummary } from '@/lib/summary';
import SourceChip from './SourceChip';
import { useSearchWords } from './searchMarks';
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
function OpCard({ op, busy, canDecide, decide }: { op: PendingOp; busy: boolean; canDecide: boolean; decide: (action: 'approve' | 'reject') => void }) {
  const removal = op.kind !== 'move';
  return (
    <div className={'review op-card' + (removal ? ' danger' : '') + (op.stale ? ' conflict' : '')}>
      <div className="review-head">
        <div>
          <div className="review-title">{op.summary}</div>
          <div className="small-text">
            {removal ? (
              'Suggested removal of this page. Its text leaves the wiki, and links to it will be left pointing nowhere.'
            ) : (
              <>
                Suggested move to <strong>{op.newPath}</strong>. Pages under it move too, and links to it are updated.
              </>
            )}{' '}
            <SourceChip source={op.source} />
          </div>
          {op.stale && <div className="muted small-text">{op.stale} It can no longer be applied.</div>}
        </div>
        {canDecide && <div className="actions">
          {!op.stale && (
            <button
              className="btn approve"
              disabled={busy}
              onClick={() => {
                if (!removal || window.confirm('Remove this page from the wiki? If it was a mistake, the page can be brought back from this page\u2019s approval history.')) decide('approve');
              }}
            >
              {removal ? 'Approve removal' : 'Approve move'}
            </button>
          )}
          <button className="btn reject" disabled={busy} onClick={() => decide('reject')}>
            Reject
          </button>
        </div>}
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
        <span className="hunk-kind">{set.isNew ? 'New page' : kind} by {set.source?.kind === 'manual' ? set.source.user : 'AI'}</span>
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
  // The live preview of what is being written is on by default: the point of the editor is to see
  // the page as it will read, with the markdown in view beside it for the brackets and lists
  const [showPreview, setShowPreview] = useState(true);

  // Formatting buttons: they go to work on the text that is selected, or drop in a sample to be
  // replaced, and the caret lands inside so the sample can be typed over
  function wrap(before: string, after: string, placeholder: string) {
    const area = bodyArea.current;
    if (!area) return;
    const { selectionStart: s, selectionEnd: e, value } = area;
    const chosen = value.slice(s, e) || placeholder;
    setDraft(value.slice(0, s) + before + chosen + after + value.slice(e));
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(s + before.length, s + before.length + chosen.length);
    });
  }
  function linePrefix(prefix: string) {
    const area = bodyArea.current;
    if (!area) return;
    const { selectionStart: s, value } = area;
    const lineStart = value.lastIndexOf('\n', Math.max(0, s - 1)) + 1;
    setDraft(value.slice(0, lineStart) + prefix + value.slice(lineStart));
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(s + prefix.length, s + prefix.length);
    });
  }
  function calendarStarter(): string {
    const t = new Date();
    const day = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    return `\`\`\`calendar\n${day} What the day is for\n\`\`\`\n`;
  }
  function mermaidStarter(): string {
    return `\`\`\`mermaid\ngraph TD\n  Alice[CEO] --> Bob[Reports to Alice]\n\`\`\`\n`;
  }
  const [draft, setDraft] = useState('');
  // The summary is edited in its own box, so it can be changed but not dropped by accident
  const [summaryDraft, setSummaryDraft] = useState('');
  const [hadSummary, setHadSummary] = useState(false);
  const [moving, setMoving] = useState(false);
  // Picking a page to link: where the selection sits in the page box while the picker is open
  const bodyArea = useRef<HTMLTextAreaElement>(null);
  const [pickingLink, setPickingLink] = useState(false);
  const pages = usePages();
  const [setIdx, setSetIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [managingAccess, setManagingAccess] = useState(false);

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

  // Opened from a search: bring the first searched-for word into view, once per page and search
  const words = useSearchWords();
  const scrolledFor = useRef('');
  useEffect(() => {
    const key = `${data?.path}|${words.join(' ')}`;
    if (!data || !words.length || editing || scrolledFor.current === key) return;
    scrolledFor.current = key;
    document.querySelector('main mark.search-mark')?.scrollIntoView({ block: 'center' });
  }, [data, words, editing]);

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
    const from = data.mySuggestion ?? (data.exists ? data.content : null);
    const split = from !== null ? splitSummary(from) : { summary: null, rest: `# ${title || data.title}\n\n` };
    setDraft(split.rest);
    setSummaryDraft(split.summary ?? '');
    setHadSummary(!!split.summary);
    setEditing(true);
  }

  // The selected text becomes the link's label; an empty selection inserts a link at the caret.
  function linkPicked(picked: string) {
    setPickingLink(false);
    const area = bodyArea.current;
    const start = area ? area.selectionStart : draft.length;
    const end = area ? area.selectionEnd : start;
    const label = draft.slice(start, end).replace(/\s+/g, ' ').trim();
    const link = label ? `[[${picked}|${label}]]` : `[[${picked}]]`;
    setDraft(draft.slice(0, start) + link + draft.slice(end));
    // Put the caret after the link, ready to carry on typing
    requestAnimationFrame(() => {
      if (!bodyArea.current) return;
      const at = start + link.length;
      bodyArea.current.focus();
      bodyArea.current.setSelectionRange(at, at);
    });
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

  const canEdit = ['edit', 'approve', 'manage'].includes(data.access.level);
  const canApprove = ['approve', 'manage'].includes(data.access.level);
  const canManage = data.access.level === 'manage';
  const suggestOnly = data.access.level === 'suggest';
  const showEdit = (data.exists && canEdit) || (suggestOnly && (data.exists || data.mySuggestion !== null));
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
      {managingAccess && (
        <AccessDialog
          path={path}
          title={data.title}
          onClose={() => setManagingAccess(false)}
          onSaved={() => {
            setManagingAccess(false);
            void load();
            onChanged();
          }}
        />
      )}
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
      {pickingLink && <LinkDialog self={path} onCancel={() => setPickingLink(false)} onPick={linkPicked} />}
      <div className="title-row">
        <h1 className="doc-title">
          {data.title}
          {data.access.limitedBy && <span className="access-tag">Limited access</span>}
        </h1>
        {!editing && (showEdit || canManage) && (
          <div className="actions">
            {showEdit && (
              <button className="btn" onClick={() => startEdit()}>
                {!suggestOnly ? 'Edit' : data.mySuggestion !== null ? 'Change my suggestion' : 'Suggest an edit'}
              </button>
            )}
            {data.exists && canEdit && (
              <>
                {data.path !== 'index' && (
                  <button className="btn quiet" onClick={() => setMoving(true)}>
                    Move
                  </button>
                )}
                <button className="btn quiet" onClick={remove}>
                  Delete
                </button>
              </>
            )}
            {canManage && (
              <button className="btn quiet" onClick={() => setManagingAccess(true)}>
                Access
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
          <div className="field">
            <div className="field-head">
              <span>Page</span>
              <span className="field-head-actions">
                <button type="button" className="btn small quiet" aria-pressed={showPreview} onClick={() => setShowPreview(!showPreview)}>
                  {showPreview ? 'Hide preview' : 'Show preview'}
                </button>
                <button type="button" className="btn small quiet" onClick={() => setPickingLink(true)}>
                  Insert link
                </button>
              </span>
            </div>
            <div className="md-toolbar" role="toolbar" aria-label="Formatting">
              {/* Each button wraps the selected text, or drops in a sample to be replaced over */}
              <button type="button" className="btn small quiet" title="Bold: **text**" onClick={() => wrap('**', '**', 'bold text')}>
                Bold
              </button>
              <button type="button" className="btn small quiet" title="Italic: *text*" onClick={() => wrap('*', '*', 'italic text')}>
                Italic
              </button>
              <button type="button" className="btn small quiet" title="Heading: ## for a section title" onClick={() => linePrefix('## ')}>
                Heading
              </button>
              <button type="button" className="btn small quiet" title="Bullet list: - item" onClick={() => linePrefix('- ')}>
                Bullet list
              </button>
              <button type="button" className="btn small quiet" title="Numbered list: 1. item" onClick={() => linePrefix('1. ')}>
                Numbered list
              </button>
              <button
                type="button"
                className="btn small quiet"
                title="Calendar: a block with one line per day, YYYY-MM-DD what the day is for"
                onClick={() => wrap(calendarStarter(), '', '')}
              >
                Calendar
              </button>
              <button
                type="button"
                className="btn small quiet"
                title="Diagram: a mermaid block the page draws, e.g. an org chart"
                onClick={() => wrap(mermaidStarter(), '', '')}
              >
                Diagram
              </button>
            </div>
            {/* The page is written in markdown and shown as it will read; the markdown side stays
                because headings, lists and [[links]] are still typed the markdown way */}
            <div className={'editor-work' + (showPreview ? ' split' : '')}>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck autoFocus ref={bodyArea} />
              {showPreview && (
                <div className="editor-preview" aria-label="What the page will read like">
                  {draft.trim() ? <Md>{draft}</Md> : <p className="muted small-text">The page reads live here as you write.</p>}
                </div>
              )}
            </div>
          </div>
          <div className="editor-bar">
            <button className="btn primary" disabled={busy || !!summaryNote} onClick={save}>
              {suggestOnly ? 'Suggest changes' : 'Save page'}
            </button>
            <button className="btn quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <span className="muted small-text">
              {suggestOnly ? 'Your changes wait on this page until someone approves them.' : `Saved edits publish right away under ${user}.`} The buttons above drop in the common things; the formatting help below lists the rest.
            </span>
          </div>
          <details className="md-help">
            <summary>Formatting help</summary>
            <ul>
              <li>
                <code>{'# Title'}</code> <code>{'## Smaller'}</code> <code>{'### Smallest'}</code> — section titles, biggest to smallest
              </li>
              <li>
                <code>{'**bold**'}</code> — bold; <code>{'*italic*'}</code> — italic
              </li>
              <li>
                <code>{'- item'}</code> — bullet list; <code>{'2 spaces in'}</code> under an item nests it
              </li>
              <li>
                <code>{'1. item'}</code> — numbered list
              </li>
              <li>
                <code>{'[[systems/radar]]'}</code> — a link to a page; <code>{'[[systems/radar|Radar]]'}</code> — a link reading Radar
              </li>
              <li>
                <code>{'| A | B |'}</code> then <code>{'| --- | --- |'}</code> then rows — a table
              </li>
              <li>
                <code>{'> quote'}</code> — a quote; <code>{'---'}</code> alone on a line — a divider
              </li>
              <li>
                a <code>{'```calendar'}</code> block with one <code>{'YYYY-MM-DD'}</code> line per day — a schedule (the Calendar button drops one in)
              </li>
              <li>
                a <code>{'```mermaid'}</code> block holding a diagram definition — the page draws it (the Diagram button drops in an org chart to edit):
                <code>{'graph TD'}</code> then lines like <code>{'Alice[CEO] --> Bob[CTO]'}</code>
              </li>
            </ul>
          </details>
        </div>
      ) : (
        <>
          {data.ops.map((op) => (
            <OpCard
              canDecide={canApprove}
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
                {canApprove && <div className="actions">
                  {!set.conflict && (
                    <button className="btn approve" disabled={busy} onClick={() => resolveAll('approve')}>
                      {changeCount > 1 ? 'Approve all' : 'Approve'}
                    </button>
                  )}
                  <button className="btn reject" disabled={busy} onClick={() => resolveAll('reject')}>
                    {changeCount > 1 && !set.conflict ? 'Reject all' : 'Reject'}
                  </button>
                </div>}
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
                    showActions={canApprove && changeCount > 1}
                    decide={(action) => guarded(() => post(`/api/proposals/${set.proposalId}/hunk`, { hunk: s.index, fp: s.fp, action, user }))}
                  />
                ),
              )
            ) : data.exists ? (
              <Summarised content={data.content} />
            ) : (
              <div className="empty">
                <p>{data.children.length ? 'This section has no page of its own yet.' : 'This page does not exist yet.'}</p>
                {(canEdit || suggestOnly) && (
                  <button className="btn primary" onClick={() => startEdit()}>
                    {suggestOnly ? 'Suggest this page' : 'Create page'}
                  </button>
                )}
              </div>
            )}
          </article>

          {data.path === 'index' && <Contents user={user} version={version} onChanged={onChanged} />}

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
          {data.exists && <PageHistory path={data.path} canUndo={canApprove} onChanged={() => (load(), onChanged())} />}
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
