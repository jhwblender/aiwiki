'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

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
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [visionModel, setVisionModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [nameNote, setNameNote] = useState('');

  useEffect(() => {
    try {
      const n = localStorage.getItem('wiki-user') || '';
      setName(n);
      setSavedName(n);
    } catch {}
  }, []);

  function saveName() {
    const n = name.trim().slice(0, 60);
    try {
      localStorage.setItem('wiki-user', n);
      setSavedName(n);
      setName(n);
      setNameNote(n ? `Saved. Your edits and approvals will show ${n}.` : 'Name removed. Edits and approvals will show anonymous.');
    } catch {
      setNameNote('This browser would not save the name.');
    }
  }

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

  return (
    <div className="settings-shell">
      <div className="topbar">
        <Link href="/wiki/index" className="btn small">
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
              <section className="card" id="your-name">
                <h2>Your name</h2>
                <p className="muted small-text">Shown on your edits and approvals. It is saved in this browser only.</p>
                <label className="field">
                  <span>Name</span>
                  <input
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setNameNote('');
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && saveName()}
                    placeholder="For example Jesse Wood"
                    autoComplete="name"
                    maxLength={60}
                  />
                </label>
                <div className="editor-bar">
                  <button className="btn primary" disabled={name.trim() === savedName} onClick={saveName}>
                    Save name
                  </button>
                  {nameNote && <span className="muted small-text">{nameNote}</span>}
                </div>
              </section>

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
            </>
          )}
        </div>
      </main>
    </div>
  );
}
