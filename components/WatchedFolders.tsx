'use client';
import { useCallback, useEffect, useState } from 'react';
import FolderPicker from './FolderPicker';

type Folder = {
  id: number;
  label: string;
  path: string;
  user: string;
  visibility: 'wiki' | 'personal';
  enabled: boolean;
  lastScanAt: string | null;
  lastError: string | null;
  fileCount: number;
  insideOf: string | null;
  contains: string[];
};

function ago(iso: string | null) {
  if (!iso) return 'not checked yet';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'checked just now';
  if (mins < 60) return `checked ${mins} minute${mins > 1 ? 's' : ''} ago`;
  return `checked ${new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

// Folders on the wiki server whose documents are filed into the wiki as they appear or change
export default function WatchedFolders() {
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [label, setLabel] = useState('');
  const [dir, setDir] = useState('');
  const [dirDisplay, setDirDisplay] = useState('');
  const [picking, setPicking] = useState(false);
  const [typing, setTyping] = useState(false);
  // The watched folder whose location is being changed
  const [moving, setMoving] = useState<number | null>(null);
  const [fileExisting, setFileExisting] = useState(true);
  const [visibility, setVisibility] = useState<'wiki' | 'personal'>('wiki');
  const [me, setMe] = useState('');

  useEffect(() => {
    fetch('/api/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setMe(d.name))
      .catch(() => {});
  }, []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setFolders(await (await fetch('/api/folders', { cache: 'no-store' })).json());
    } catch {
      setMessage({ kind: 'error', text: 'Could not load watched folders.' });
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  async function call(url: string, init: RequestInit, done?: (d: any) => string) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'That did not work.');
      if (done) setMessage({ kind: 'ok', text: done(d) });
      await load();
      return true;
    } catch (e: any) {
      setMessage({ kind: 'error', text: e.message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const ok = await call(
      '/api/folders',
      { method: 'POST', body: JSON.stringify({ label, path: dir, fileExisting, visibility }) },
      (d) =>
        `Watching "${d.label}" (${d.fileCount} document${d.fileCount === 1 ? '' : 's'} found). ` +
        (fileExisting ? 'They are being filed in the background.' : 'Only new and changed documents will be filed.'),
    );
    if (ok) {
      setLabel('');
      setDir('');
      setDirDisplay('');
    }
  }

  return (
    <section className="card" id="folders">
      <h2>Watched folders</h2>
      <p className="muted small-text">
        The wiki checks these folders on its server every minute. New and changed documents are filed in the background, and what they add
        shows up as suggestions on the pages. The wiki never changes the folder. Sources show the folder label and the path inside it.
      </p>

      {folders && folders.length > 0 && (
        <ul className="folders">
          {folders.map((f) => (
            <li key={f.id} className={'folder' + (f.enabled ? '' : ' paused')}>
              <div className="folder-body">
                <strong>{f.label}</strong>
                {f.visibility === 'personal' && <span className="personal-badge">Personal to {f.user}</span>}
                {!f.enabled && <span className="muted small-text"> (paused)</span>}
                <div className="muted small-text folder-path">{f.path}</div>
                <div className="small-text">
                  {f.fileCount} document{f.fileCount === 1 ? '' : 's'}, {ago(f.lastScanAt)}
                  {f.visibility === 'personal' ? `, kept for ${f.user}'s searches only` : f.user && f.user !== 'anonymous' ? `, filed as ${f.user}` : ''}
                </div>
                {f.insideOf && (
                  <div className="muted small-text">Inside &quot;{f.insideOf}&quot;. Its documents are filed under this folder only.</div>
                )}
                {f.contains.length > 0 && (
                  <div className="muted small-text">
                    Leaves out {f.contains.map((c) => `"${c}"`).join(', ')}, which {f.contains.length > 1 ? 'are' : 'is'} watched
                    separately.
                  </div>
                )}
                {f.lastError && <div className="small-text error-text">{f.lastError}</div>}
              </div>
              <div className="folder-actions">
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() =>
                    call(`/api/folders/${f.id}/scan`, { method: 'POST' }, (d) =>
                      d.queued
                        ? `${d.queued} new or changed document${d.queued > 1 ? 's' : ''} sent for filing.`
                        : 'Nothing new or changed.',
                    )
                  }
                >
                  Check now
                </button>
                <button
                  className="btn small quiet"
                  disabled={busy}
                  aria-expanded={moving === f.id}
                  onClick={() => setMoving(moving === f.id ? null : f.id)}
                >
                  Change folder
                </button>
                <button
                  className="btn small quiet"
                  disabled={busy}
                  onClick={() => call(`/api/folders/${f.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !f.enabled }) })}
                >
                  {f.enabled ? 'Pause' : 'Resume'}
                </button>
                <button
                  className="btn small quiet"
                  disabled={busy}
                  onClick={() => {
                    if (f.visibility === 'wiki') {
                      if (
                        window.confirm(
                          `Make "${f.label}" personal to ${f.user}? Its documents will only show up in ${f.user}'s searches, and nothing new from it goes into the wiki. What is already in the wiki stays.`,
                        )
                      ) {
                        call(
                          `/api/folders/${f.id}`,
                          { method: 'PATCH', body: JSON.stringify({ visibility: 'personal' }) },
                          () => `"${f.label}" is now personal.`,
                        );
                      }
                    } else if (window.confirm(`Let "${f.label}" feed the wiki? Everyone's searches will include its documents.`)) {
                      const fileNow = window.confirm(
                        `Also file the ${f.fileCount} documents already in "${f.label}" into the wiki now? Choose Cancel to file only new and changed ones.`,
                      );
                      call(
                        `/api/folders/${f.id}`,
                        { method: 'PATCH', body: JSON.stringify({ visibility: 'wiki', fileExisting: fileNow }) },
                        (d) =>
                          d.queued
                            ? `"${f.label}" now feeds the wiki; ${d.queued} documents are being filed.`
                            : `"${f.label}" now feeds the wiki.`,
                      );
                    }
                  }}
                >
                  {f.visibility === 'personal' ? 'Feed the wiki' : 'Make personal'}
                </button>
                <button
                  className="btn small quiet"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Stop watching "${f.label}"? Its waiting files are cancelled, and nothing already in the wiki changes.`)) {
                      call(`/api/folders/${f.id}`, { method: 'DELETE' });
                    }
                  }}
                >
                  Stop watching
                </button>
              </div>
              {moving === f.id && (
                <div className="folder-move">
                  <p className="small-text">
                    Choose where &quot;{f.label}&quot; is now. The folder goes by the new top level folder&apos;s name, and documents already filed
                    from it are not filed again.
                  </p>
                  <FolderPicker
                    start={f.path}
                    onCancel={() => setMoving(null)}
                    onPick={async (p) => {
                      const ok = await call(
                        `/api/folders/${f.id}`,
                        { method: 'PATCH', body: JSON.stringify({ path: p }) },
                        (d) => `"${d.label ?? f.label}" now points to its new location. The wiki is checking it now.`,
                      );
                      if (ok) setMoving(null);
                    }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="card-sub">{folders?.length ? 'Watch another folder' : 'Watch a folder'}</h3>
      <label className="field">
        <span>Label</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="For example Systems SharePoint" maxLength={80} />
      </label>
      <div className="field">
        <span>Folder on the wiki server</span>
        {typing ? (
          <input
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="For example C:\Users\you\OneDrive - Company\Systems"
            spellCheck={false}
            autoComplete="off"
            aria-label="Folder path"
          />
        ) : dir ? (
          <div className="chosen-folder">
            <code>{dirDisplay || dir}</code>
            <button type="button" className="btn small quiet" onClick={() => setPicking(true)}>
              Choose another
            </button>
          </div>
        ) : (
          !picking && (
            <div className="chosen-folder">
              <button type="button" className="btn" onClick={() => setPicking(true)}>
                Choose folder
              </button>
            </div>
          )
        )}
        {picking && !typing && (
          <FolderPicker
            start={dir || undefined}
            onCancel={() => setPicking(false)}
            onPick={(p, name, display) => {
              setDir(p);
              setDirDisplay(display);
              if (!label.trim()) setLabel(name);
              setPicking(false);
            }}
          />
        )}
        <button
          type="button"
          className="link-button small-text type-path"
          onClick={() => {
            setTyping(!typing);
            setPicking(false);
          }}
        >
          {typing ? 'Choose from a list instead' : 'Type a path instead'}
        </button>
      </div>
      <p className="muted small-text field-help">
        A Windows path works when the wiki runs in WSL. For a SharePoint library, sync it with OneDrive and turn off Files On-Demand for
        that folder so the files are really on disk.
      </p>
      <fieldset className="field visibility">
        <legend>What it is for</legend>
        <label className="check small-text">
          <input type="radio" name="visibility" checked={visibility === 'wiki'} onChange={() => setVisibility('wiki')} /> Feeds the wiki:
          its documents become suggestions anyone can review
        </label>
        <label className="check small-text">
          <input type="radio" name="visibility" checked={visibility === 'personal'} onChange={() => setVisibility('personal')} /> Personal:
          only {me || 'you'} can search it from the chat, and nothing from it goes into the wiki
        </label>
        {visibility === 'personal' && !me && (
          <p className="small-text error-text">Set your name at the top of this page first; a personal folder belongs to someone.</p>
        )}
      </fieldset>
      <label className="check small-text">
        <input type="checkbox" checked={fileExisting} onChange={(e) => setFileExisting(e.target.checked)} />{' '}
        {visibility === 'personal' ? 'Also include the documents already in the folder' : 'Also file the documents already in the folder'}
      </label>
      <div className="editor-bar">
        <button className="btn primary" disabled={busy || !label.trim() || !dir.trim()} onClick={add}>
          {busy ? 'Working' : 'Watch folder'}
        </button>
      </div>
      {message && <div className={message.kind === 'ok' ? 'notice' : 'error'}>{message.text}</div>}
    </section>
  );
}
