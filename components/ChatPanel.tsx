'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ChatMsg, ChatResponse } from '@/lib/types';
import Md from './Md';
import { usePages } from './WikiContext';

type UiMsg = ChatMsg & { trace?: string[]; proposed?: { path: string; isNew: boolean }[]; error?: boolean };

function newChat(): string {
  // randomUUID needs https or localhost; getRandomValues also works over plain http on the network
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    localStorage.setItem('wiki-chat-id', id);
  } catch {}
  return id;
}

export default function ChatPanel({
  user,
  currentPath,
  onChanged,
}: {
  user: string;
  currentPath: string;
  onChanged: () => void;
}) {
  const [msgs, setMsgs] = useState<UiMsg[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Identifies this conversation so a follow-up message revises its own earlier suggestion
  const [chatId, setChatId] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // null until /api/config answers, so the "no model" notice does not flash on load
  const [providerList, setProviders] = useState<{ id: string; label: string }[] | null>(null);
  const providers = providerList ?? [];
  const [provider, setProvider] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const pages = usePages();

  useEffect(() => {
    try {
      setChatId(localStorage.getItem('wiki-chat-id') || newChat());
      const saved = localStorage.getItem('wiki-chat');
      if (saved) setMsgs(JSON.parse(saved));
      setProvider(localStorage.getItem('wiki-provider') || '');
    } catch {}
    setLoaded(true);
    fetch('/api/config')
      .then((r) => r.json())
      .then((d) => setProviders(d.providers || []))
      .catch(() => setProviders([]));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem('wiki-chat', JSON.stringify(msgs.slice(-40)));
    } catch {}
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgs, busy, loaded]);

  // Clearing starts a new conversation; later messages no longer revise earlier suggestions
  function clear() {
    setMsgs([]);
    setChatId(newChat());
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const next: UiMsg[] = [...msgs, { role: 'user', content: text }];
    setMsgs(next);
    setInput('');
    setBusy(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: next.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })),
          provider: provider || providers[0]?.id,
          user,
          currentPath,
          chatId,
        }),
      });
      const d: ChatResponse = await r.json();
      if (!r.ok || d.error) {
        setMsgs([...next, { role: 'assistant', content: d.error || 'Something went wrong.', error: true }]);
      } else {
        setMsgs([...next, { role: 'assistant', content: d.reply, trace: d.trace, proposed: d.proposed }]);
        if (d.proposed.length) onChanged();
      }
    } catch (e: any) {
      setMsgs([...next, { role: 'assistant', content: e.message || 'Network error', error: true }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="chat">
      <header className="chat-head">
        <strong>Assistant</strong>
        {providers.length > 1 && (
          <select
            value={provider || providers[0]?.id}
            onChange={(e) => {
              setProvider(e.target.value);
              localStorage.setItem('wiki-provider', e.target.value);
            }}
            aria-label="Model"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <button className="btn quiet small" disabled={busy || msgs.length === 0} onClick={clear}>
          Clear
        </button>
      </header>

      <div className="chat-log">
        {providerList && providers.length === 0 && (
          <div className="notice">
            No AI model is set up yet. <Link href="/settings">Open Settings</Link> to connect a local model.
          </div>
        )}
        {msgs.length === 0 && providers.length > 0 && (
          <div className="muted pad">
            Ask a question about the wiki, or tell me something new. For example: &quot;The VPN request form moved to the IT portal.&quot; I will propose the edit and you approve it on the page.
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}${m.error ? ' err' : ''}`}>
            {m.trace && m.trace.length > 0 && (
              <details className="trace">
                <summary>{m.trace.length} step{m.trace.length > 1 ? 's' : ''}</summary>
                <ul>
                  {m.trace.map((t, j) => (
                    <li key={j}>{t}</li>
                  ))}
                </ul>
              </details>
            )}
            {m.role === 'assistant' && !m.error ? <Md>{m.content || '(no reply)'}</Md> : <p>{m.content}</p>}
            {m.error && (
              <p className="small-text">
                <Link href="/settings">Check the model settings</Link>
              </p>
            )}
            {m.proposed && m.proposed.length > 0 && (
              <div className="proposed">
                <span>Waiting for review:</span>
                {m.proposed.map((p) => (
                  <Link key={p.path} href={`/wiki/${p.path}`} className="pill">
                    {pages.get(p.path)?.title ?? p.path}
                    {p.isNew ? ' (new page)' : ''}
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="msg assistant muted">Working</div>}
        <div ref={endRef} />
      </div>

      <div className="chat-input">
        <textarea
          value={input}
          rows={2}
          placeholder="Ask or add information"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 901px)').matches) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn primary" disabled={busy || !input.trim() || providers.length === 0} onClick={send}>
          Send
        </button>
      </div>
    </aside>
  );
}
