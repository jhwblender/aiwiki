'use client';
import { useState } from 'react';
import Link from 'next/link';
import type { HistoryAction, HistoryEntry } from '@/lib/types';

const VERB: Record<HistoryAction['kind'], string> = { created: 'Created', removed: 'Removed', moved: 'Moved', edited: 'Edited' };

function when(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function confirmText(a: HistoryAction): string {
  switch (a.kind) {
    case 'removed':
      return `Bring back "${a.title}"? Anything approved or written since stays as it is.`;
    case 'created':
      return `Remove "${a.title}"? It has not changed since it was approved.`;
    case 'moved':
      return `Move "${a.title}" back where it was? Links follow, as they did before.`;
    default:
      return `Take back this approved edit on "${a.title}"? Anything changed since stays as it is.`;
  }
}

// An entry whose change has plainly been reversed already says so instead of offering an undo
function alreadyDone(e: HistoryEntry): string | null {
  const kinds = new Set(e.actions.map((a) => a.kind));
  if (kinds.size === 1 && kinds.has('removed') && e.actions.every((a) => a.exists)) return 'It is back in the wiki already.';
  if (kinds.size === 1 && kinds.has('created') && e.actions.every((a) => !a.exists)) return 'It is not in the wiki any more.';
  return null;
}

// The list of approvals, with the undo that puts back what an approval changed
export default function HistoryList({ entries, canUndo, onChanged }: { entries: HistoryEntry[]; canUndo: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  async function undo(e: HistoryEntry) {
    setBusy(e.commit);
    setError('');
    setNote('');
    try {
      const r = await fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undo', commit: e.commit }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'That did not work.');
      setNote('Undone.');
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div>
      {error && <div className="error">{error}</div>}
      {note && <div className="notice">{note}</div>}
      <ul className="history-list">
        {entries.map((e) => {
          const done = alreadyDone(e);
          return (
            <li key={e.commit} className="history-entry">
              <div>
                {e.actions.map((a, i) => (
                  <span key={i}>
                    {i > 0 && ' '}
                    {VERB[a.kind]}{' '}
                    {a.exists ? (
                      <Link href={`/wiki/${a.kind === 'moved' ? a.newPath : a.path}`}>{a.title}</Link>
                    ) : (
                      <Link href={`/history?page=${encodeURIComponent(a.path)}`}>{a.title}</Link>
                    )}
                    {a.kind === 'moved' && a.newTitle && <span className="muted"> to {a.newTitle}</span>}
                  </span>
                ))}
              </div>
              {e.summary && <div className="muted small-text">{e.summary}</div>}
              <div className="history-meta">
                <span className="muted small-text">
                  approved by {e.approver}, {when(e.at)}
                </span>
                {canUndo && !done && (
                  <button className="btn small quiet" disabled={busy === e.commit} onClick={() => window.confirm(confirmText(e.actions[0])) && undo(e)}>
                    Undo
                  </button>
                )}
                {done && <span className="muted small-text">{done}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}