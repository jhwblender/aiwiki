'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { slugify } from './Md';
import { usePages } from './WikiContext';

// Choosing where a page lives by picking a place in the page tree and typing a title, instead of
// typing a path. The path is worked out from the title and the place, and links follow a move.

type Place = { path: string; title: string; depth: number };

const MAX_DEPTH = 5;

export function titleOf(pages: Map<string, { title: string }>, p: string): string {
  return pages.get(p)?.title ?? (p.split('/').pop() || p).replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export default function PlaceDialog({
  mode,
  page,
  initialTitle = '',
  initialParent = '',
  busy,
  onCancel,
  onDone,
}: {
  mode: 'new' | 'move';
  page?: string; // the page being moved; it and the pages under it cannot be its new place
  initialTitle?: string;
  initialParent?: string;
  busy?: boolean;
  onCancel: () => void;
  onDone: (path: string, title: string) => void;
}) {
  const pages = usePages();
  const [title, setTitle] = useState(initialTitle);
  const [parent, setParent] = useState(initialParent);
  const [filter, setFilter] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  // Every page and folder that can hold another page, in tree order
  const places = useMemo(() => {
    const paths = new Set<string>();
    for (const p of pages.keys()) {
      if (p === 'index') continue;
      const parts = p.split('/');
      for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join('/'));
    }
    const out: Place[] = [...paths]
      .filter((p) => p.split('/').length < MAX_DEPTH && !(page && (p === page || p.startsWith(page + '/'))))
      .map((p) => ({ path: p, title: titleOf(pages, p), depth: p.split('/').length - 1 }));
    // sort by the titles along the way, so children sit under their parent
    const key = (p: string) => p.split('/').map((_, i, a) => titleOf(pages, a.slice(0, i + 1).join('/')).toLowerCase()).join('\u0000');
    return out.sort((a, b) => key(a.path).localeCompare(key(b.path)));
  }, [pages, page]);

  const shown = filter.trim()
    ? places.filter((p) => p.title.toLowerCase().includes(filter.trim().toLowerCase()) || p.path === parent)
    : places;

  const name = slugify(title).replace(/\//g, '-');
  const target = name ? (parent ? `${parent}/${name}` : name) : '';
  const taken = !!target && target !== page && pages.has(target);
  const unchanged = mode === 'move' && target === page;
  const trail = (p: string) =>
    p
      ? p
          .split('/')
          .map((_, i, a) => titleOf(pages, a.slice(0, i + 1).join('/')))
          .join(' › ')
      : 'Top level';

  return (
    <dialog ref={dialog} className="place-dialog" onClose={onCancel}>
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (target && !taken && !unchanged) onDone(target, title.trim());
        }}
      >
        <h2>{mode === 'new' ? 'New page' : 'Move or rename'}</h2>
        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="For example Backup policy" />
        </label>
        <div className="field">
          <span>Put it in</span>
          {places.length > 8 && (
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a section" aria-label="Find a section" />
          )}
          <ul className="place-list" role="radiogroup" aria-label="Where the page goes">
            <li>
              <label className={parent === '' ? 'picked' : ''}>
                <input type="radio" name="place" checked={parent === ''} onChange={() => setParent('')} />
                Top level
              </label>
            </li>
            {shown.map((p) => (
              <li key={p.path} style={{ paddingLeft: filter ? 0 : p.depth * 16 }}>
                <label className={parent === p.path ? 'picked' : ''}>
                  <input type="radio" name="place" checked={parent === p.path} onChange={() => setParent(p.path)} />
                  {p.title}
                </label>
              </li>
            ))}
          </ul>
        </div>
        <p className="small-text muted">
          {target ? (
            <>
              It will be at <strong>{trail(parent)}</strong> › <strong>{title.trim()}</strong>.
              {mode === 'move' && ' Pages under it move too, and links to it are updated everywhere.'}
            </>
          ) : (
            'Type a title.'
          )}
        </p>
        {taken && <div className="error">A page with that title is already there. Choose another title or place.</div>}
        <div className="editor-bar">
          <button type="submit" className="btn primary" disabled={busy || !target || taken || unchanged}>
            {mode === 'new' ? 'Create page' : 'Move page'}
          </button>
          <button type="button" className="btn quiet" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
