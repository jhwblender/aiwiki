'use client';
import { useEffect, useState } from 'react';

type Shortcut = { label: string; path: string; display: string };
type Listing = {
  path: string;
  display: string;
  name: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  more: number;
  docs: number;
};

// The folders above a path, for the clickable trail at the top
function trail(p: string): { label: string; path: string }[] {
  const drive = p.match(/^\/mnt\/([a-z])(?=\/|$)/);
  const start = drive ? `/mnt/${drive[1]}` : '/';
  const out = [{ label: drive ? `${drive[1].toUpperCase()}:` : '/', path: start }];
  let cur = start;
  for (const part of p.slice(start.length).split('/').filter(Boolean)) {
    cur = cur === '/' ? `/${part}` : `${cur}/${part}`;
    out.push({ label: part, path: cur });
  }
  return out;
}

// Browse folders on the wiki server and pick one (to move a watched folder to), or tick several
// to watch in one go: the ticked selection builds up while you browse, so folders that sit next
// to each other do not have to be walked to one at a time.
export default function FolderPicker({
  start,
  mode = 'pick',
  confirmLabel = 'Use this folder',
  onPick,
  onSelect,
  onCancel,
}: {
  start?: string;
  mode?: 'pick' | 'select';
  confirmLabel?: string;
  onPick?: (path: string, name: string, display: string) => void;
  // Returning the paths that were watched lets the ticks for them be dropped, so a batch where
  // some folders could not be watched can be finished without sending the finished ones again
  onSelect?: (picks: { path: string; name: string }[]) => string[] | void | Promise<string[] | void>;
  onCancel: () => void;
}) {
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // What has been ticked so far, by path; kept across navigation until the picker closes
  const [checked, setChecked] = useState<Map<string, string>>(new Map());
  // True while the chosen folders are being watched, so the confirm button cannot be hit twice
  const [saving, setSaving] = useState(false);

  async function open(p: string): Promise<boolean> {
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`/api/folders/browse?path=${encodeURIComponent(p)}`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not open that folder.');
      setListing(d);
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetch('/api/folders/browse', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        setShortcuts(d.shortcuts ?? []);
        const fallback = d.shortcuts?.[0]?.path;
        // A folder that was moved away cannot be opened; start from the first shortcut instead
        if (start) void open(start).then((ok) => !ok && fallback && open(fallback));
        else if (fallback) void open(fallback);
      })
      .catch(() => setError('Could not list folders on the wiki server.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (path: string, name: string) =>
    setChecked((prev) => {
      const next = new Map(prev);
      if (next.has(path)) next.delete(path);
      else next.set(path, name);
      return next;
    });

  return (
    <div className="picker" role="group" aria-label={mode === 'select' ? 'Choose folders to watch' : 'Choose a folder'}>
      {shortcuts.length > 0 && (
        <div className="picker-shortcuts">
          {shortcuts.map((s) => (
            <button
              key={s.path}
              type="button"
              className={'btn small' + (listing?.path === s.path ? ' picked' : ' quiet')}
              onClick={() => open(s.path)}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {listing && (
        <nav className="picker-trail" aria-label="Current folder">
          {trail(listing.path).map((t, i, all) => (
            <span key={t.path}>
              {i > 0 && <span className="muted"> / </span>}
              {i < all.length - 1 ? (
                <button type="button" className="link-button" onClick={() => open(t.path)}>
                  {t.label}
                </button>
              ) : (
                <strong>{t.label}</strong>
              )}
            </span>
          ))}
        </nav>
      )}

      {error && <div className="error">{error}</div>}

      <ul className="picker-list" aria-busy={loading}>
        {listing?.parent && (
          <li>
            <button type="button" className="picker-row" onClick={() => open(listing.parent!)}>
              Up one level
            </button>
          </li>
        )}
        {mode === 'select' && listing && (
          <li>
            <label className="picker-check">
              <input type="checkbox" aria-label={`Watch ${listing.name}`} checked={checked.has(listing.path)} onChange={() => toggle(listing.path, listing.name)} />
              <span className="picker-check-name">This folder itself</span>
            </label>
          </li>
        )}
        {listing?.dirs.map((d) => (
          <li key={d.path}>
            {mode === 'select' ? (
              <div className="picker-check">
                <input type="checkbox" aria-label={`Watch ${d.name}`} checked={checked.has(d.path)} onChange={() => toggle(d.path, d.name)} />
                <button type="button" className="picker-row folder-row" onClick={() => open(d.path)}>
                  {d.name}
                </button>
              </div>
            ) : (
              <button type="button" className="picker-row folder-row" onClick={() => open(d.path)}>
                {d.name}
              </button>
            )}
          </li>
        ))}
        {listing && listing.dirs.length === 0 && <li className="muted small-text picker-empty">No folders inside this one.</li>}
        {listing && listing.more > 0 && <li className="muted small-text picker-empty">And {listing.more} more not shown.</li>}
      </ul>

      <div className="picker-foot">
        <span className="muted small-text">
          {mode === 'select' && checked.size > 0
            ? `${checked.size} folder${checked.size === 1 ? '' : 's'} selected`
            : listing
              ? `${listing.display}: ${listing.docs} document${listing.docs === 1 ? '' : 's'} directly in this folder`
              : loading
                ? 'Loading'
                : ''}
        </span>
        <span className="spacer" />
        <button type="button" className="btn quiet small" onClick={onCancel}>
          Cancel
        </button>
        {mode === 'select' ? (
          <button
            type="button"
            className="btn primary small"
            disabled={loading || saving || checked.size === 0}
            onClick={async () => {
              const picks = [...checked].map(([path, name]) => ({ path, name }));
              setSaving(true);
              try {
                const watched = await onSelect?.(picks);
                if (Array.isArray(watched) && watched.length) {
                  setChecked((prev) => {
                    const next = new Map(prev);
                    for (const p of watched) next.delete(p);
                    return next;
                  });
                }
              } finally {
                setSaving(false);
              }
            }}
          >
            {checked.size > 0 ? `Watch ${checked.size} folder${checked.size === 1 ? '' : 's'}` : 'Watch the selected folders'}
          </button>
        ) : (
          <button
            type="button"
            className="btn primary small"
            disabled={!listing || loading}
            onClick={() => listing && onPick?.(listing.path, listing.name, listing.display)}
          >
            {confirmLabel}
          </button>
        )}
      </div>
    </div>
  );
}