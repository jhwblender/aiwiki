'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { PageListItem } from '@/lib/types';
import PlaceDialog from './PlaceDialog';
import { useInstall } from './InstallApp';

type Node = { name: string; path: string; page?: PageListItem; children: Map<string, Node> };

// Which folders the person left open, remembered between visits; the tree starts closed and only
// what they opened (or where they are now) is visible
const OPEN_KEY = 'wiki-tree-open';

function savedOpen(): Set<string> {
  const set = new Set<string>();
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY) || '[]');
    if (Array.isArray(saved)) for (const p of saved) if (typeof p === 'string') set.add(p);
  } catch {}
  return set;
}

// The folder levels from the top down to where the person is, so the current page is visible
function pathTo(current: string): string[] {
  const parts = current.split('/');
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join('/');
    if (p) out.push(p);
  }
  return out;
}

function buildTree(items: PageListItem[]): Node {
  const root: Node = { name: '', path: '', children: new Map() };
  for (const it of items) {
    let cur = root;
    const parts = it.path.split('/');
    parts.forEach((part, i) => {
      const p = parts.slice(0, i + 1).join('/');
      if (!cur.children.has(part)) cur.children.set(part, { name: part, path: p, children: new Map() });
      cur = cur.children.get(part)!;
    });
    cur.page = it;
  }
  return root;
}

function Branch({ node, current, open, toggle }: { node: Node; current: string; open: Set<string>; toggle: (path: string) => void }) {
  // The home page is the wiki's front door, so it comes first; then folders that only group pages,
  // then everything else, each alphabetically
  const rank = (n: Node) => (n.path === 'index' ? 0 : n.children.size > 0 && !n.page ? 1 : 2);
  const kids = [...node.children.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return (
    <ul className="tree">
      {kids.map((k) => {
        const item = k.page ? (
          <Link href={`/wiki/${k.page.path}`} className={'tree-item' + (k.path === current ? ' active' : '')}>
            <span className="tree-name">{k.page.title}</span>
            {k.page.pending > 0 && (
              <span className="badge" title={`${k.page.pending} suggestion${k.page.pending > 1 ? 's' : ''} waiting for review`}>
                {k.page.isNew ? 'new' : k.page.pending}
              </span>
            )}
          </Link>
        ) : (
          <Link href={`/wiki/${k.path}`} className={'tree-folder' + (k.path === current ? ' active' : '')}>
            {k.name.replace(/[-_]/g, ' ')}
          </Link>
        );
        // Only a level that holds something underneath carries the caret; a page at the end of a
        // branch sits at the same left edge as the folder names beside it, without a slot of its own
        if (k.children.size === 0) return <li key={k.path}>{item}</li>;
        return (
          <li key={k.path}>
            <div className="tree-row">
              <button
                type="button"
                className={'tree-caret' + (open.has(k.path) ? ' open' : '')}
                aria-expanded={open.has(k.path)}
                aria-label={`${open.has(k.path) ? 'Collapse' : 'Expand'} ${k.name.replace(/[-_]/g, ' ')}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(k.path);
                }}
              />
              {item}
            </div>
            {open.has(k.path) && <Branch node={k} current={current} open={open} toggle={toggle} />}
          </li>
        );
      })}
    </ul>
  );
}

export default function Sidebar({
  current,
  items,
  pendingTotal,
  user,
  role,
  onNavigate,
}: {
  current: string;
  items: PageListItem[];
  pendingTotal: number;
  user: string;
  role: string;
  onNavigate: () => void;
}) {
  const router = useRouter();
  const install = useInstall();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ path: string; title: string; snippet: string }[] | null>(null);

  useEffect(() => {
    if (!q.trim()) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => {
      fetch('/api/search?q=' + encodeURIComponent(q))
        .then((r) => r.json())
        .then((d) => setHits(Array.isArray(d) ? d : []))
        .catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const tree = useMemo(() => buildTree(items), [items]);

  // Which folders are open: what the person opened before (remembered between visits), plus the
  // levels down to the page they are on now, so the current page is visible without hunting for
  // it. The remembered opens are the only thing saved; the levels above the current page last
  // only while they are on that page.
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    setOpen(savedOpen());
  }, []);
  useEffect(() => {
    if (!current) return;
    setOpen((prev) => {
      const next = new Set(prev);
      for (const p of pathTo(current)) next.add(p);
      return next;
    });
  }, [current]);
  // A waiting suggestion hangs its badge on the page it belongs to, whose levels are closed, so
  // the levels down to every page carrying suggestions open on their own; they last only while
  // the suggestions do
  useEffect(() => {
    if (!items.length) return;
    const paths: string[] = [];
    for (const it of items) if (it.pending > 0) paths.push(...pathTo(it.path));
    if (!paths.length) return;
    setOpen((prev) => {
      const next = new Set(prev);
      for (const p of paths) next.add(p);
      return next.size === prev.size ? prev : next;
    });
  }, [items]);
  const toggle = (path: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  };

  const [creating, setCreating] = useState(false);
  // A new page goes beside the current one, or under it when it is a section
  const hasChildren = items.some((i) => i.path.startsWith(current + '/'));
  const defaultParent = !current || current === 'index' ? '' : hasChildren ? current : current.split('/').slice(0, -1).join('/');

  function created(path: string, title: string) {
    setCreating(false);
    try {
      sessionStorage.setItem('wiki-new-page', JSON.stringify({ path, title }));
    } catch {}
    onNavigate();
    router.push(`/wiki/${path}`);
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <Link href="/wiki/index" onClick={onNavigate}>
          Wiki
        </Link>
        <button className="btn small" onClick={() => setCreating(true)}>
          New page
        </button>
        {creating && <PlaceDialog mode="new" initialParent={defaultParent} onCancel={() => setCreating(false)} onDone={created} />}
      </div>
      <input
        className="search"
        placeholder="Search pages"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search pages"
      />
      {pendingTotal > 0 && !hits && (
        <div className="review-note">
          {pendingTotal} suggestion{pendingTotal > 1 ? 's' : ''} waiting for review
        </div>
      )}
      <nav className="nav" onClick={onNavigate}>
        {hits ? (
          hits.length ? (
            <ul className="tree">
              {hits.map((h) => (
                <li key={h.path}>
                  <Link href={`/wiki/${h.path}`} className="tree-item hit">
                    <span className="tree-name">{h.title}</span>
                    <span className="hit-snippet">{h.snippet.replace(/\n+/g, ' ')}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted pad">No pages match.</div>
          )
        ) : (
          <Branch node={tree} current={current} open={open} toggle={toggle} />
        )}
      </nav>
      <div className="whoami">
        <span>
          Signed in as <strong>{user.trim()}</strong>
          {role ? <span className="muted"> · {role}</span> : null}
        </span>
        <div className="side-links">
          <Link href="/wiki/index#contents" className="settings-link">
            Contents
          </Link>
          <Link href="/history" className="settings-link">
            History
          </Link>
          <Link href="/settings" className="settings-link">
            Settings
          </Link>
          {install.available && (
            <button className="settings-link" onClick={install.show}>
              Install app
            </button>
          )}
          <button
            className="settings-link"
            onClick={async () => {
              try {
                await fetch('/api/login', { method: 'DELETE' });
              } catch {}
              window.location.href = '/login';
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
