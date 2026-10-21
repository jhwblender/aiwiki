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

const RUN_KEY = 'wiki-chat-run';
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
  // Live progress of the message being answered
  const [live, setLive] = useState<{ steps: string[]; status: string; started: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const runIdRef = useRef<string | null>(null);
  const readerRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  // Closing the panel only stops listening; the request keeps running on the server
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
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

  // Hand the files to the background queue: one job each, results show up as suggestions on pages
  async function fileInBackground() {
    if (!ready.length || busy || uploading) return;
    const note = input.trim();
    const sent: UiMsg = { role: 'user', content: note || 'File these in the background.', attachments: ready };
    setBusy(true);
    try {
      const r = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: ready.map((f) => f.id), note: note || undefined, user, currentPath, provider: provider || providers[0]?.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not queue the files.');
      const n = ready.length;
      setMsgs((m) => [
        ...m,
        sent,
        {
          role: 'assistant',
          content: `Filing ${n === 1 ? 'this file' : `these ${n} files`} in the background, one at a time. Suggestions appear on the pages as each one is done, and the [Settings page](/settings#background) shows progress.`,
        },
      ]);
      setPending([]);
      setInput('');
      void followJobs(d.jobs as number[]);
    } catch (e: any) {
      setMsgs((m) => [...m, sent, { role: 'assistant', content: e.message, error: true }]);
    } finally {
      setBusy(false);
    }
  }

  // Watch queued jobs: refresh the page as each finishes, then summarise in the chat
  async function followJobs(ids: number[]) {
    const open = new Set(ids);
    const finished: any[] = [];
    for (let i = 0; i < 400 && open.size; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      let jobs: any[] = [];
      try {
        jobs = await (await fetch('/api/ingest', { cache: 'no-store' })).json();
      } catch {
        continue;
      }
      let changed = false;
      for (const j of jobs) {
        if (open.has(j.id) && j.status !== 'queued' && j.status !== 'working') {
          open.delete(j.id);
          finished.push(j);
          changed = true;
        }
      }
      if (changed) onChanged();
    }
    if (!finished.length) return;
    const lines = finished.map((j) => {
      if (j.status === 'done') {
        return j.proposed.length
          ? `- ${j.displayName}: suggestions on ${j.proposed.map((p: string) => `[[${p}]]`).join(', ')}`
          : `- ${j.displayName}: nothing to add`;
      }
      if (j.status === 'skipped') return `- ${j.displayName}: skipped. ${j.detail ?? ''}`;
      return `- ${j.displayName}: failed. ${j.detail ?? ''} You can try again from the [Settings page](/settings#background).`;
    });
    setMsgs((m) => [...m, { role: 'assistant', content: `Background filing finished:\n\n${lines.join('\n')}` }]);
  }

  // The server runs a request even if this panel closes; remember it so the panel can reconnect
  function rememberRun(id: string, started: number) {
    runIdRef.current = id;
    try {
      localStorage.setItem(RUN_KEY, JSON.stringify({ id, started }));
    } catch {}
  }

  const onProgress = (text: string) =>
    setLive((l) => (l ? (/^Thinking/.test(text) ? { ...l, status: text } : { ...l, steps: [...l.steps, text], status: 'Working' }) : l));

  // Show the result of a run, once
  function finish(d: ChatResponse) {
    try {
      localStorage.removeItem(RUN_KEY);
    } catch {}
    if (d.error === 'Stopped.') {
      setMsgs((m) => [...m, { role: 'assistant', content: 'Stopped. Anything already suggested stays on its page for review.' }]);
      onChanged();
    } else if (d.error) {
      setMsgs((m) => [...m, { role: 'assistant', content: d.error!, error: true }]);
    } else {
      setMsgs((m) => [...m, { role: 'assistant', content: d.reply, trace: d.trace, proposed: d.proposed }]);
      if (d.proposed.length) onChanged();
    }
  }

  // Follow a run until it ends. Returns quietly if the panel closed meanwhile; the run carries on
  // on the server and the panel reconnects when it opens again.
  async function follow(open: () => Promise<Response>, started: number) {
    setBusy(true);
    setLive({ steps: [], status: 'Sending', started });
    const controller = new AbortController();
    readerRef.current = controller;
    try {
      const r = await open();
      if (r.status === 404) {
        finish({ reply: '', trace: [], proposed: [], error: 'The wiki restarted while working on your last message. Send it again.' });
        return;
      }
      const d = await readReply(r, controller.signal, (id) => rememberRun(id, started), onProgress);
      if (!mounted.current) return;
      finish(d);
    } catch (e: any) {
      if (!mounted.current || e?.name === 'AbortError') return;
      finish({ reply: '', trace: [], proposed: [], error: e.message || 'Network error' });
    } finally {
      if (mounted.current) {
        setBusy(false);
        setLive(null);
        runIdRef.current = null;
      }
    }
  }

  // Pick up a run that was still going when the panel last closed
  useEffect(() => {
    if (!loaded) return;
    let saved: { id: string; started: number } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(RUN_KEY) || 'null');
    } catch {}
    if (!saved?.id) return;
    runIdRef.current = saved.id;
    void follow(() => fetch(`/api/chat/runs/${saved!.id}`, { cache: 'no-store', signal: readerRef.current?.signal }), saved.started);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  function stop() {
    const id = runIdRef.current;
    if (id) void fetch(`/api/chat/runs/${id}/stop`, { method: 'POST' });
    setLive((l) => (l ? { ...l, status: 'Stopping after this step' } : l));
  }

  async function send() {
    const text = input.trim() || (ready.length ? 'Add what is useful from the attached files to the wiki.' : '');
    if (!text || busy || uploading) return;
    const next: UiMsg[] = [...msgs, { role: 'user', content: text, attachments: ready.length ? ready : undefined }];
    setMsgs(next);
    setInput('');
    setPending([]);
    const body = JSON.stringify({
      stream: true,
      // Earlier attachments are named in their message; only the latest message's files are read
      messages: next
        .filter((m) => !m.error)
        .map((m, i, all) => ({
          role: m.role,
          content: m.attachments?.length && i < all.length - 1 ? `${m.content}\n\n[Attached: ${m.attachments.map((a) => a.name).join(', ')}]` : m.content,
        })),
      attachments: ready.map((f) => f.id),
      provider: provider || providers[0]?.id,
      user,
      currentPath,
      chatId,
    });
    await follow(
      () => fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: readerRef.current?.signal }),
      Date.now(),
    );
  }

  // Read the streamed reply: progress lines while the assistant works, then the result
  async function readReply(r: Response, signal: AbortSignal, onRun: (id: string) => void, onProgress: (text: string) => void): Promise<ChatResponse> {
    if (!r.body || !(r.headers.get('content-type') ?? '').includes('ndjson')) return r.json();
    const reader = r.body.getReader();
    signal.addEventListener('abort', () => void reader.cancel().catch(() => {}));
    const decoder = new TextDecoder();
    let buf = '';
    let result: ChatResponse | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'run') onRun(ev.id);
        else if (ev.type === 'progress') onProgress(ev.text);
        else if (ev.type === 'done') result = ev;
        else if (ev.type === 'error') result = { reply: '', trace: [], proposed: [], error: ev.error };
      }
    }
    return result ?? { reply: '', trace: [], proposed: [], error: 'The reply was cut off. Try again.' };
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
        {busy && live && (
          <div className="msg assistant live" aria-live="polite">
            <div className="live-head">
              <span className="live-dot" aria-hidden="true" />
              <span>
                {live.status} for {Math.max(0, Math.round((now - live.started) / 1000))}s
              </span>
              <span className="spacer" />
              <button className="btn quiet small" onClick={stop}>
                Stop
              </button>
            </div>
            {live.steps.length > 0 && (
              <ul className="live-steps">
                {live.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            )}
            {now - live.started > 20000 && live.steps.length === 0 && (
              <p className="small-text muted">A local model can take a minute or more to load and start answering.</p>
            )}
          </div>
        )}
        {busy && !live && <div className="msg assistant muted">Working</div>}
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
            // Enter sends; Shift+Enter adds a line. On touch screens Enter adds a line and the Send button sends.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia('(pointer: coarse)').matches) {
              e.preventDefault();
              send();
            }
          }}
        />
        <span className="send-group">
          {ready.length > 0 && (
            <button className="btn" disabled={busy || uploading || providers.length === 0} onClick={fileInBackground}>
              File in the background
            </button>
          )}
          <button
            className="btn primary"
            disabled={busy || uploading || (!input.trim() && !ready.length) || providers.length === 0}
            onClick={send}
          >
            Send
          </button>
        </span>
      </div>
    </aside>
  );
}
