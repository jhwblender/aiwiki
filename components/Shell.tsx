'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { PageListItem } from '@/lib/types';
import Sidebar from './Sidebar';
import PageView from './PageView';
import ChatPanel, { type IncomingFiles } from './ChatPanel';
import { PagesContext } from './WikiContext';

const NARROW = '(max-width: 900px)';

function pathFrom(pathname: string): string {
  const rest = pathname.replace(/^\/wiki\/?/, '');
  return rest.split('/').map((s) => decodeURIComponent(s)).filter(Boolean).join('/') || 'index';
}

export default function Shell() {
  const path = pathFrom(usePathname() || '');
  // Who is signed in comes from the session; without one, the browser goes to the login page
  const [user, setUserState] = useState('');
  const [role, setRole] = useState('');
  const [signedIn, setSignedIn] = useState(false);
  const [version, setVersion] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [items, setItems] = useState<PageListItem[]>([]);
  // Files dropped onto the page, handed to the assistant
  const [incoming, setIncoming] = useState<IncomingFiles | null>(null);

  useEffect(() => {
    fetch('/api/me', { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) {
          window.location.href = '/login';
          return null;
        }
        return r.json();
      })
      .then((d) => {
        if (d) {
          setUserState(d.name);
          setRole(d.role);
          setSignedIn(true);
        }
      })
      .catch(() => {
        window.location.href = '/login';
      });
    try {
      setChatOpen(!window.matchMedia(NARROW).matches && localStorage.getItem('wiki-chat-open') !== '0');
    } catch {}
  }, []);

  useEffect(() => {
    fetch('/api/pages', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setItems(d))
      .catch(() => {});
  }, [version, path]);

  // On a phone the page, the page list and the assistant each take the whole screen; navigating shows the page.
  useEffect(() => {
    setSideOpen(false);
    if (window.matchMedia(NARROW).matches) setChatOpen(false);
    // Settings' "Back to wiki" returns here
    try {
      sessionStorage.setItem('wiki-last-path', path);
    } catch {}
  }, [path]);

  const pages = useMemo(() => new Map(items.map((i) => [i.path, i])), [items]);
  const pendingTotal = items.reduce((n, i) => n + i.pending, 0);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // Refresh when anything changes on the server: background filing, watched folders, other people
  useEffect(() => {
    let last = '';
    let stopped = false;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const { stamp } = await (await fetch('/api/pulse', { cache: 'no-store' })).json();
        if (!stopped && last && stamp !== last) bump();
        last = stamp;
      } catch {}
    };
    void check();
    const t = setInterval(check, 4000);
    const onVisible = () => void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [bump]);
  const effectiveUser = user.trim() || 'anonymous';

  function toggleChat() {
    const open = !chatOpen;
    setChatOpen(open);
    if (open) setSideOpen(false);
    try {
      if (!window.matchMedia(NARROW).matches) localStorage.setItem('wiki-chat-open', open ? '1' : '0');
    } catch {}
  }

  function toggleSide() {
    const open = !sideOpen;
    setSideOpen(open);
    if (open && window.matchMedia(NARROW).matches) setChatOpen(false);
  }

  // Nothing appears until the session is confirmed; unsigned browsers are on their way to /login
  if (!signedIn) return <div className="shell" />;

  return (
    <PagesContext.Provider value={pages}>
      <div className={`shell${chatOpen ? ' chat-on' : ''}${sideOpen ? ' side-on' : ''}`}>
        <div className="topbar">
          <button className="btn small pages-toggle" aria-expanded={sideOpen} onClick={toggleSide}>
            Pages
            {pendingTotal > 0 && <span className="badge" aria-label={`${pendingTotal} waiting for review`}>{pendingTotal}</span>}
          </button>
          <span className="spacer" />
          <button className="btn small" aria-expanded={chatOpen} onClick={toggleChat}>
            {chatOpen ? 'Hide assistant' : 'Assistant'}
          </button>
        </div>
        <Sidebar
          current={path}
          items={items}
          pendingTotal={pendingTotal}
          user={user}
          role={role}
          onNavigate={() => setSideOpen(false)}
        />
        <PageView
          path={path}
          user={effectiveUser}
          version={version}
          onChanged={bump}
          onDropFiles={(files) => {
            setIncoming({ files, note: 'Add what is useful from the attached files to this page.', key: Date.now() });
            setChatOpen(true);
            setSideOpen(false);
          }}
        />
        {chatOpen && (
          <ChatPanel user={effectiveUser} currentPath={path} onChanged={bump} incoming={incoming} onIncomingTaken={() => setIncoming(null)} />
        )}
      </div>
    </PagesContext.Provider>
  );
}
