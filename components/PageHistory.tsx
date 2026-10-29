'use client';
import { useCallback, useEffect, useState } from 'react';
import HistoryList from './HistoryList';
import type { HistoryEntry } from '@/lib/types';

// The approval history of the page being read: what suggestions were approved on it and an undo
// for each. Folded away by default, because a page is for reading first.
export default function PageHistory({ path, role, onChanged }: { path: string; role: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/history?page=${encodeURIComponent(path)}`, { cache: 'no-store' });
      const d = await r.json();
      if (!Array.isArray(d.entries)) throw new Error(d.error || 'Could not load the history.');
      setEntries(d.entries);
      setError('');
    } catch (e: any) {
      setError(e.message);
    }
  }, [path]);

  useEffect(() => {
    if (open && entries === null) load();
  }, [open, entries, load]);

  return (
    <footer className="page-history">
      <button className="btn small quiet" onClick={() => setOpen(!open)}>
        {open ? 'Hide approval history' : 'Approval history'}
      </button>
      {open && (
        <div className="page-history-body">
          {error && <div className="error">{error}</div>}
          {entries === null && !error && <p className="muted small-text">Loading</p>}
          {entries !== null && entries.length === 0 && <p className="muted small-text">Nothing approved has touched this page.</p>}
          {entries !== null && entries.length > 0 && (
            <HistoryList entries={entries} canUndo={role === 'editor' || role === 'admin'} onChanged={() => (load(), onChanged())} />
          )}
        </div>
      )}
    </footer>
  );
}