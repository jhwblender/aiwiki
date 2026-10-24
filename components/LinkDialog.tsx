'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { titleOf } from './PlaceDialog';
import { usePages } from './WikiContext';

// Picking a page to link, instead of typing [[page/path]]. The link keeps working when the
// page moves, wherever it sits now.

export default function LinkDialog({ self, onCancel, onPick }: { self?: string; onCancel: () => void; onPick: (path: string) => void }) {
  const pages = usePages();
  const [filter, setFilter] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  // Every page, in tree order like the place picker
  const items = useMemo(() => {
    const list = [...pages.values()].map((p) => ({ path: p.path, title: p.title, depth: p.path.split('/').length - 1 }));
    const key = (p: string) => p.split('/').map((_, i, a) => titleOf(pages, a.slice(0, i + 1).join('/')).toLowerCase()).join('\u0000');
    return list.sort((a, b) => key(a.path).localeCompare(key(b.path)));
  }, [pages]);

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? items.filter((p) => p.title.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle))
    : items;

  return (
    <dialog ref={dialog} className="place-dialog" onClose={onCancel}>
      <form method="dialog" onSubmit={(e) => e.preventDefault()}>
        <h2>Link to a page</h2>
        {items.length > 8 && (
          <input className="link-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a page" autoFocus aria-label="Find a page" />
        )}
        <ul className="place-list link-list" aria-label="Pages">
          {shown.length ? (
            shown.map((p) => (
              <li key={p.path} style={{ paddingLeft: filter ? 0 : p.depth * 16 }}>
                <button type="button" onClick={() => onPick(p.path)}>
                  {p.title}
                  {p.path === self && <span className="muted"> (this page)</span>}
                  {p.path !== p.title.toLowerCase() && p.path !== p.title && <span className="muted small-text"> — {p.path}</span>}
                </button>
              </li>
            ))
          ) : (
            <li className="muted pad">No page matches.</li>
          )}
        </ul>
        <div className="editor-bar">
          <button type="button" className="btn quiet" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <p className="small-text muted">The link keeps working if the page moves.</p>
      </form>
    </dialog>
  );
}