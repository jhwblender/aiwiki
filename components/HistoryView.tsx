'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import HistoryList from './HistoryList';
import type { HistoryEntry } from '@/lib/types';

// The approvals a person can look back over: what was approved, who approved it, and an undo for
// when a click went to the wrong button. Wiki-wide this lists the pages suggestions created,
// removed and moved; with a page it lists everything approved there.
export default function HistoryView({ page }: { page?: string }) {
  const [me, setMe] = useState<{ role: string } | null>(null);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [backTo, setBackTo] = useState('/wiki/index');

  useEffect(() => {
    fetch('/api/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) window.location.href = '/login';
        else setMe(d);
      })
      .catch(() => (window.location.href = '/login'));
    try {
      const last = sessionStorage.getItem('wiki-last-path');
      if (last) setBackTo(`/wiki/${last}`);
    } catch {}
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/history${page ? `?page=${encodeURIComponent(page)}` : ''}`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not load the history.');
      setEntries(d.entries);
      setMore(!!d.more);
      setError('');
    } catch (e: any) {
      setError(e.message);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const canUndo = me?.role === 'editor' || me?.role === 'admin';

  return (
    <div className="settings-shell">
      <div className="topbar">
        <Link href={backTo} className="btn small">
          Back to wiki
        </Link>
      </div>
      <main className="page settings">
        <div className="settings-body">
          <h1 className="doc-title">Approval history</h1>
          <section className="card">
            <p className="muted small-text">
              {page
                ? `Approved changes that touched "${page}", newest first. Undo puts back what the approval changed; anything done since stays as it is.`
                : 'Every page a suggestion created, removed or moved, newest first, and who approved it. Undo puts back what the approval changed; anything done since stays as it is.'}
            </p>
            {error && <div className="error">{error}</div>}
            {!entries && !error && <p className="muted small-text">Loading</p>}
            {entries && entries.length === 0 && <p className="muted">Nothing has been approved from a suggestion yet.</p>}
            {entries && entries.length > 0 && <HistoryList entries={entries} canUndo={canUndo} onChanged={load} />}
            {more && <p className="muted small-text">Older approvals are not shown.</p>}
          </section>
        </div>
      </main>
    </div>
  );
}