'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { PageListItem } from '@/lib/types';
import { slugify } from './Md';

type Node = { name: string; path: string; page?: PageListItem; children: Map<string, Node> };

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

function Branch({ node, current, depth }: { node: Node; current: string; depth: number }) {
  const kids = [...node.children.values()].sort((a, b) => {
    const af = a.children.size > 0 && !a.page ? 0 : 1;
    const bf = b.children.size > 0 && !b.page ? 0 : 1;
    return af - bf || a.name.localeCompare(b.name);
  });
  return (
    <ul className="tree" style={{ paddingLeft: depth ? 12 : 0 }}>
      {kids.map((k) => (
        <li key={k.path}>
          {k.page ? (
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
          )}
          {k.children.size > 0 && <Branch node={k} current={current} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

export default function Sidebar({
  current,
  items,
  pendingTotal,
  user,
  onNavigate,
}: {
  current: string;
  items: PageListItem[];
  pendingTotal: number;
  user: string;
  onNavigate: () => void;
}) {
  const router = useRouter();
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

  function newPage() {
    const name = window.prompt('Page title or path (for example systems/backup-policy)');
    if (!name) return;
    const slug = slugify(name);
    if (slug) {
      onNavigate();
      router.push(`/wiki/${slug}`);
    }
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <Link href="/wiki/index" onClick={onNavigate}>
          Team wiki
        </Link>
        <button className="btn small" onClick={newPage}>
          New page
        </button>
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
          <Branch node={tree} current={current} depth={0} />
        )}
      </nav>
      <div className="whoami">
        {user.trim() ? (
          <span>
            Approving as <strong>{user.trim()}</strong>
          </span>
        ) : (
          <Link href="/settings#your-name" className="name-missing">
            Set your name so approvals show who made them
          </Link>
        )}
        <div className="side-links">
          <Link href="/structure" className="settings-link">
            Structure
          </Link>
          <Link href="/settings" className="settings-link">
            Settings
          </Link>
        </div>
      </div>
    </aside>
  );
}
