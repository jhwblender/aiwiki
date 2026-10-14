'use client';
import { useCallback, useEffect, useState } from 'react';
import Sidebar from './Sidebar';
import PageView from './PageView';
import ChatPanel from './ChatPanel';

export default function Shell({ path }: { path: string }) {
  const [user, setUserState] = useState('');
  const [version, setVersion] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);

  useEffect(() => {
    try {
      setUserState(localStorage.getItem('wiki-user') || '');
      setChatOpen(window.matchMedia('(min-width: 901px)').matches && localStorage.getItem('wiki-chat-open') !== '0');
    } catch {}
  }, []);

  const setUser = (u: string) => {
    setUserState(u);
    try {
      localStorage.setItem('wiki-user', u);
    } catch {}
  };
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const effectiveUser = user.trim() || 'anonymous';

  function toggleChat() {
    setChatOpen((o) => {
      try {
        localStorage.setItem('wiki-chat-open', o ? '0' : '1');
      } catch {}
      return !o;
    });
  }

  return (
    <div className={`shell${chatOpen ? ' chat-on' : ''}${sideOpen ? ' side-on' : ''}`}>
      <div className="topbar">
        <button className="btn small" onClick={() => setSideOpen((s) => !s)}>
          Pages
        </button>
        <span className="spacer" />
        <button className="btn small" onClick={toggleChat}>
          {chatOpen ? 'Hide assistant' : 'Assistant'}
        </button>
      </div>
      <Sidebar current={path} version={version} user={user} setUser={setUser} onNavigate={() => setSideOpen(false)} />
      <PageView path={path} user={effectiveUser} version={version} onChanged={bump} />
      {chatOpen && <ChatPanel user={effectiveUser} currentPath={path} onChanged={bump} onClose={toggleChat} />}
    </div>
  );
}
