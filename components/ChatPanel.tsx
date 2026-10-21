'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Attachment, ChatMsg, ChatResponse } from '@/lib/types';
import Md from './Md';
import { usePages } from './WikiContext';

type UiMsg = ChatMsg & {
  trace?: string[];
  proposed?: { path: string; isNew: boolean }[];
  error?: boolean;
  attachments?: Attachment[];
};

// A file picked for the next message, uploaded as soon as it is added
type Pending = { key: number; name: string; status: 'uploading' | 'ready' | 'error'; file?: Attachment; error?: string };

// Files handed over from elsewhere, such as a drop onto the page
export type IncomingFiles = { files: File[]; note: string; key: number };

const ACCEPT = '.pdf,.docx,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.gif,.webp';
const MAX_FILES = 10;
let nextKey = 1;

function newChat(): string {
  // randomUUID needs https or localhost; getRandomValues also works over plain http on the network
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    localStorage.setItem('wiki-chat-id', id);
  } catch {}
  return id;
}

function sizeLabel(bytes: number) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function ChatPanel({
  user,
  currentPath,
  onChanged,
  incoming,
  onIncomingTaken,
}: {
  user: string;
  currentPath: string;
  onChanged: () => void;
  incoming?: IncomingFiles | null;
  onIncomingTaken?: () => void;
}) {
  const [msgs, setMsgs] = useState<UiMsg[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Identifies this conversation so a follow-up message revises its own earlier suggestion
  const [chatId, setChatId] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  // null until /api/config answers, so the "no model" notice does not flash on load
  const [providerList, setProviders] = useState<{ id: string; label: string }[] | null>(null);
  const providers = providerList ?? [];
  const [provider, setProvider] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    if (!incoming?.files.length) return;
    addFiles(incoming.files);
    setInput((v) => v || incoming.note);
    onIncomingTaken?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.key]);

  function addFiles(list: File[]) {
    const room = MAX_FILES - pending.length;
    const files = list.slice(0, Math.max(0, room));
    for (const f of files) {
      const key = nextKey++;
      setPending((p) => [...p, { key, name: f.name || 'pasted image', status: 'uploading' }]);
      const form = new FormData();
      form.append('file', f, f.name || 'pasted-image.png');
      form.append('user', user);
      fetch('/api/files', { method: 'POST', body: form })
        .then(async (r) => {
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Upload failed');
          setPending((p) => p.map((x) => (x.key === key ? { ...x, status: 'ready', file: d[0] } : x)));
        })
        .catch((e) => setPending((p) => p.map((x) => (x.key === key ? { ...x, status: 'error', error: e.message } : x))));
    }
    if (list.length > files.length) {
      setPending((p) => [...p, { key: nextKey++, name: `${list.length - files.length} more`, status: 'error', error: `At most ${MAX_FILES} files per message` }]);
    }
  }

  // Clearing starts a new conversation; later messages no longer revise earlier suggestions
  function clear() {
    setMsgs([]);
    setChatId(newChat());
  }

  const ready = pending.filter((p) => p.status === 'ready' && p.file).map((p) => p.file!);
  const uploading = pending.some((p) => p.status === 'uploading');

  async function send() {
    const text = input.trim() || (ready.length ? 'Add what is useful from the attached files to the wiki.' : '');
    if (!text || busy || uploading) return;
    const next: UiMsg[] = [...msgs, { role: 'user', content: text, attachments: ready.length ? ready : undefined }];
    setMsgs(next);
    setInput('');
    setPending([]);
    setBusy(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Earlier attachments are named in their message; only the latest message's files are read
          messages: next
            .filter((m) => !m.error)
            .map((m, i, all) => ({
              role: m.role,
              content:
                m.attachments?.length && i < all.length - 1 ? `${m.content}\n\n[Attached: ${m.attachments.map((a) => a.name).join(', ')}]` : m.content,
            })),
          attachments: ready.map((f) => f.id),
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

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  return (
    <aside
      className={'chat' + (dragging ? ' dragging' : '')}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        addFiles(Array.from(e.dataTransfer.files));
      }}
    >
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
            Ask a question about the wiki, or tell me something new. For example: &quot;The VPN request form moved to the IT portal.&quot; I will
            propose the edit and you approve it on the page. You can also attach documents and photos, or drop them here.
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}${m.error ? ' err' : ''}`}>
            {m.trace && m.trace.length > 0 && (
              <details className="trace">
                <summary>
                  {m.trace.length} step{m.trace.length > 1 ? 's' : ''}
                </summary>
                <ul>
                  {m.trace.map((t, j) => (
                    <li key={j}>{t}</li>
                  ))}
                </ul>
              </details>
            )}
            {m.role === 'assistant' && !m.error ? <Md>{m.content || '(no reply)'}</Md> : <p>{m.content}</p>}
            {m.attachments && m.attachments.length > 0 && (
              <div className="msg-files">
                {m.attachments.map((a) => (
                  <a key={a.id} href={`/api/files/${a.id}`} target="_blank" rel="noreferrer" className="file-chip">
                    {a.name}
                  </a>
                ))}
              </div>
            )}
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
        {busy && (
          <div className="msg assistant muted">
            {msgs[msgs.length - 1]?.attachments?.length ? 'Reading the files, then working. Photos and scans can take a few minutes.' : 'Working'}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {dragging && <div className="drop-hint">Drop files to attach them</div>}

      {pending.length > 0 && (
        <ul className="pending-files" aria-label="Attached files">
          {pending.map((p) => (
            <li key={p.key} className={'file-chip ' + p.status} title={p.error}>
              <span>
                {p.name}
                {p.status === 'uploading' && ' (uploading)'}
                {p.status === 'ready' && p.file && ` (${sizeLabel(p.file.size)})`}
                {p.status === 'error' && `: ${p.error}`}
              </span>
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${p.name}`}
                onClick={() => setPending((all) => all.filter((x) => x.key !== p.key))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="chat-input">
        <input
          ref={pickerRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <button className="btn quiet small attach" type="button" disabled={busy} onClick={() => pickerRef.current?.click()}>
          Attach files
        </button>
        <textarea
          value={input}
          rows={2}
          placeholder={ready.length ? 'Say what to do with the files, or just send' : 'Ask or add information'}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 901px)').matches) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          className="btn primary"
          disabled={busy || uploading || (!input.trim() && !ready.length) || providers.length === 0}
          onClick={send}
        >
          Send
        </button>
      </div>
    </aside>
  );
}
