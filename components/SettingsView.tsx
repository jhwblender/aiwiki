'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import BackgroundJobs from './BackgroundJobs';
import Librarian from './Librarian';
import WatchedFolders from './WatchedFolders';

type Settings = {
  local: { baseUrl: string; model: string; visionModel: string; hasApiKey: boolean };
  anthropic: { configured: boolean; model: string };
};
type TestResult = {
  ok: boolean;
  steps: { label: string; status: 'passed' | 'failed' | 'skipped'; detail: string; optional?: boolean }[];
  models: string[];
};

const PRESETS = [
  { label: 'Ollama', url: 'http://localhost:11434/v1' },
  { label: 'LM Studio', url: 'http://localhost:1234/v1' },
];

export default function SettingsView() {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [backTo, setBackTo] = useState('/wiki/index');

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
          setLoadState(d.role === 'admin' ? 'ready' : 'notAdmin');
          setMe(d);
        }
      })
      .catch(() => (window.location.href = '/login'));
    try {
      const last = sessionStorage.getItem('wiki-last-path');
      if (last) setBackTo(`/wiki/${last}`);
    } catch {}
  }, []);
  const [loadState, setLoadState] = useState<'checking' | 'ready' | 'notAdmin'>('checking');
  const [me, setMe] = useState<{ name: string; role: string } | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [visionModel, setVisionModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  function load(s: Settings) {
    setSaved(s);
    setBaseUrl(s.local.baseUrl);
    setModel(s.local.model);
    setVisionModel(s.local.visionModel);
    setApiKey('');
    setClearKey(false);
  }

  useEffect(() => {
    fetch('/api/settings', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(load)
      .catch(() => setMessage({ kind: 'error', text: 'Could not load settings.' }));
  }, []);

  const dirty =
    !!saved &&
    (baseUrl.trim() !== saved.local.baseUrl ||
      model.trim() !== saved.local.model ||
      visionModel.trim() !== saved.local.visionModel ||
      apiKey.trim() !== '' ||
      clearKey);

  async function runTest() {
    setBusy('test');
    setTest(null);
    setMessage(null);
    try {
      const r = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, model, visionModel, apiKey: clearKey ? '' : apiKey }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'The test could not run.');
      setTest(d);
    } catch (e: any) {
      setMessage({ kind: 'error', text: e.message });
    } finally {
      setBusy('');
    }
  }

  async function save() {
    setBusy('save');
    setMessage(null);
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, model, visionModel, apiKey: clearKey ? '' : apiKey.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Save failed.');
      load(d);
      setMessage({ kind: 'ok', text: 'Settings saved. The assistant uses them from the next message.' });
    } catch (e: any) {
      setMessage({ kind: 'error', text: e.message });
    } finally {
      setBusy('');
    }
  }

  if (loadState === 'checking') {
    return (
      <div className="settings-shell">
        <main className="page settings">
          <div className="settings-body">
            <h1 className="doc-title">Settings</h1>
            <p className="muted">Loading</p>
          </div>
        </main>
      </div>
    );
  }
  if (loadState === 'notAdmin') {
    return (
      <div className="settings-shell">
        <main className="page settings">
          <div className="settings-body">
            <h1 className="doc-title">Settings</h1>
            <div className="card">
              <p className="muted">
                Signed in as {me?.name ?? ''} ({me?.role ?? ''}). The settings here — the model connection, watched folders and people — are managed by
                admins.
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="settings-shell">
      <div className="topbar">
        <Link href={backTo} className="btn small">
          Back to wiki
        </Link>
      </div>
      <main className="page settings">
        <div className="settings-body">
          <h1 className="doc-title">Settings</h1>
          {!saved ? (
            message ? (
              <div className="error">{message.text}</div>
            ) : (
              <p className="muted">Loading</p>
            )
          ) : (
            <>
              <People />

              <section className="card">
                <h2>Local AI model</h2>
                <p className="muted small-text">
                  Any server that speaks the OpenAI chat format works, such as Ollama, LM Studio or vLLM. The wiki server connects to it, so
                  the address must be reachable from where the wiki runs.
                </p>

                <label className="field">
                  <span>Server address</span>
                  <input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="http://localhost:11434/v1"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <div className="presets">
                  <span className="muted small-text">Fill in:</span>
                  {PRESETS.map((p) => (
                    <button key={p.label} type="button" className="btn small quiet" onClick={() => setBaseUrl(p.url)}>
                      {p.label}
                    </button>
                  ))}
                </div>

                <label className="field">
                  <span>Model</span>
                  <input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="qwen2.5:7b-instruct"
                    list="model-options"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <datalist id="model-options">
                    {test?.models.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </label>
                {test && test.models.length > 0 && (
                  <div className="presets">
                    <span className="muted small-text">On this server:</span>
                    {test.models.slice(0, 8).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={'btn small' + (m === model ? ' picked' : ' quiet')}
                        onClick={() => setModel(m)}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}

                <label className="field">
                  <span>Model for photos and scans (optional)</span>
                  <input
                    value={visionModel}
                    onChange={(e) => setVisionModel(e.target.value)}
                    placeholder={`Leave blank to use ${model.trim() || 'the model above'}`}
                    list="model-options"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <p className="muted small-text field-help">
                  Only needed if the main model cannot read images. Vision models include qwen2.5vl and llava.
                </p>

                <label className="field">
                  <span>API key (optional)</span>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setClearKey(false);
                    }}
                    placeholder={
                      saved.local.hasApiKey && !clearKey ? 'A key is saved; type to replace it' : 'Only if your server asks for one'
                    }
                    autoComplete="off"
                  />
                </label>
                {saved.local.hasApiKey && (
                  <label className="check small-text">
                    <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> Remove the saved key
                  </label>
                )}

                <div className="editor-bar">
                  <button className="btn" disabled={!!busy || !baseUrl.trim()} onClick={runTest}>
                    {busy === 'test' ? 'Testing' : 'Test connection'}
                  </button>
                  <button className="btn primary" disabled={!!busy || !dirty} onClick={save}>
                    {busy === 'save' ? 'Saving' : 'Save settings'}
                  </button>
                </div>
                {busy === 'test' && <p className="muted small-text">A model that is not loaded yet can take a minute to answer.</p>}

                {message && <div className={message.kind === 'ok' ? 'notice' : 'error'}>{message.text}</div>}

                {test && (
                  <div className="test-result" role="status">
                    <p className={'test-summary ' + (test.ok ? 'passed' : 'failed')}>
                      {!test.ok
                        ? 'The connection test found a problem.'
                        : test.steps.some((st) => st.optional && st.status !== 'passed')
                          ? 'The assistant works. Photos and scanned documents need a model that can read images.'
                          : 'Everything works.'}
                      {test.ok && dirty && ' Save the settings to start using them.'}
                    </p>
                    <ol className="test-steps">
                      {test.steps.map((st) => (
                        <li key={st.label} className={st.status}>
                          <span className="step-status">
                            {st.status === 'passed' ? 'Passed' : st.status === 'failed' ? 'Failed' : 'Skipped'}
                          </span>
                          <div>
                            <strong>{st.label}</strong>
                            <div className="small-text">{st.detail}</div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                <details className="help small-text">
                  <summary>Running the wiki in WSL and the model on Windows?</summary>
                  <p>
                    localhost inside WSL may not reach a program running on Windows. Either turn on mirrored networking for WSL, or use the
                    Windows machine&apos;s address instead of localhost. For Ollama, also set OLLAMA_HOST=0.0.0.0 so it accepts the
                    connection, and raise its context length (OLLAMA_CONTEXT_LENGTH=16384) so long pages are not cut off.
                  </p>
                </details>
              </section>

              <section className="card">
                <h2>Anthropic</h2>
                <p className="small-text">
                  {saved.anthropic.configured
                    ? `Set up through .env.local, using ${saved.anthropic.model}.`
                    : 'Not set up. Add ANTHROPIC_API_KEY to .env.local and restart the wiki to use Claude.'}
                </p>
              </section>

              <WatchedFolders />

              <Librarian />

              <BackgroundJobs />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

const ROLES: { id: 'viewer' | 'editor' | 'admin'; label: string; hint: string }[] = [
  { id: 'viewer', label: 'Viewer', hint: 'reads pages, searches, asks the assistant' },
  { id: 'editor', label: 'Editor', hint: 'edits pages, reviews suggestions, drops files, watches folders' },
  { id: 'admin', label: 'Admin', hint: 'editor, plus Settings, People and everything an editor can do' },
];

// Accounts and roles. Only admins can see this section — the API refuses anyone else.
function People() {
  const [me, setMe] = useState<{ name: string; role: string } | null>(null);
  const [users, setUsers] = useState<{ name: string; role: string; created: string }[] | null>(null);
  const [name, setName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor' | 'admin'>('editor');
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && !d.error && setMe(d))
      .catch(() => {});
  }, []);

  const isAdmin = me?.role === 'admin';

  function load() {
    fetch('/api/users', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUsers(d))
      .catch(() => setUsers(null));
  }
  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin]);

  async function act(method: 'POST' | 'PATCH' | 'DELETE', body?: any, param?: string) {
    setNote(null);
    const r = await fetch('/api/users' + (param ?? ''), { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setNote({ kind: 'error', text: d.error || 'That did not work.' });
      return false;
    }
    return true;
  }

  if (!isAdmin) {
    return me ? (
      <section className="card">
        <h2>People</h2>
        <p className="muted small-text">You are signed in as {me.name} ({me.role}). Only admins manage accounts here.</p>
      </section>
    ) : null;
  }

  return (
    <section className="card">
      <h2>People</h2>
      <p className="muted small-text">
        Viewer: read, search and chat. Editor: also edit pages, review suggestions, drop files and watch folders.
        Admin: also these settings. New people sign in with the passcode set here and can change it on request.
      </p>
      {users && (
        <table className="people-table">
          <tbody>
            {users.map((u) => (
              <tr key={u.name}>
                <td className="people-name">{u.name}</td>
                <td>
                  <select value={u.role} onChange={async (e) => (await act('PATCH', { name: u.name, role: e.target.value })) && load()}>
                    {ROLES.map((r) => (
                      <option key={r.id} value={r.id}>{r.label}</option>
                    ))}
                  </select>
                </td>
                <td className="muted small-text">{(ROLES.find((r) => r.id === u.role) ?? ROLES[1]).hint}</td>
                <td>
                  {u.name !== me?.name && (
                    <button
                      className="btn small"
                      onClick={async () => {
                        const who = window.prompt(`New passcode for ${u.name} (at least 8 characters)`);
                        if (who) await act('PATCH', { name: u.name, passcode: who }) && load();
                      }}
                    >
                      Reset passcode
                    </button>
                  )}
                </td>
                <td>
                  {u.name !== me?.name && (
                    <button
                      className="btn small"
                      onClick={async () => window.confirm(`Remove the account ${u.name}?`) && (await act('DELETE', undefined, `?name=${encodeURIComponent(u.name)}`)) && load()}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="editor-bar add-person">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name, for example Sam Taylor"
          maxLength={60}
          className="people-name-input"
        />
        <input
          type="password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          placeholder="Passcode (at least 8 characters)"
          className="people-pass-input"
        />
        <select value={role} onChange={(e) => setRole(e.target.value as 'viewer' | 'editor' | 'admin')}>
          {ROLES.map((r) => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>
        <button
          className="btn primary"
          disabled={!name.trim() || passcode.length < 8}
          onClick={async () => (await act('POST', { name, passcode, role })) && (setName(''), setPasscode(''), load())}
        >
          Add person
        </button>
      </div>
      {note && <span className={note.kind === 'ok' ? 'muted small-text' : 'login-error'}>{note.text}</span>}
    </section>
  );
}
