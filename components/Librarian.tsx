'use client';
import { useCallback, useEffect, useState } from 'react';

type Run = 'queued' | 'working' | null;
type Section = { section: string; title: string; pages: number; run: Run };
type Data = { sections: Section[]; whole: { run: Run }; settings: { limit: number; auto: boolean }; maxLimit: number };

const WHOLE = '*';

// The librarian keeps the wiki organised. It runs on its own after the wiki changes, and any part can
// be tidied now. Runs go through background filing, and what they suggest is reviewed on the pages.
export default function Librarian() {
  const [data, setData] = useState<Data | null>(null);
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/librarian', { cache: 'no-store' });
      const d: Data = await r.json();
      setData(d);
      setLimit((cur) => cur || String(d.settings.limit));
    } catch {
      setMessage({ kind: 'error', text: 'Could not load the librarian.' });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the buttons in step while a run is waiting or running
  const active = !!data && (!!data.whole.run || data.sections.some((s) => s.run));
  useEffect(() => {
    const t = setInterval(load, active ? 3000 : 15000);
    return () => clearInterval(t);
  }, [active, load]);

  async function tidy(section: string, name: string) {
    setBusy(section);
    setMessage(null);
    let user = '';
    let provider = '';
    try {
      user = localStorage.getItem('wiki-user') || '';
      provider = localStorage.getItem('wiki-provider') || '';
    } catch {}
    try {
      const r = await fetch('/api/librarian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, user, provider: provider || undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'The tidy could not start.');
      setMessage({
        kind: 'ok',
        text: `${section === WHOLE ? 'Organising' : 'Tidying'} ${name}. Follow it under Background filing; its suggestions appear on the pages for review.`,
      });
    } catch (e: any) {
      setMessage({ kind: 'error', text: e.message });
    } finally {
      setBusy('');
      load();
    }
  }

  async function save(change: { limit?: number; auto?: boolean }) {
    setBusy('settings');
    setMessage(null);
    try {
      const r = await fetch('/api/librarian', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not save.');
      setLimit(String(d.limit));
      setMessage({ kind: 'ok', text: 'Saved.' });
    } catch (e: any) {
      setMessage({ kind: 'error', text: e.message });
    } finally {
      setBusy('');
      load();
    }
  }

  const label = (run: Run, starting: boolean, action = 'Tidy') =>
    run === 'working' ? (action === 'Tidy' ? 'Tidying' : 'Organising') : run === 'queued' ? 'Waiting' : starting ? 'Starting' : action;

  return (
    <section className="card" id="librarian">
      <h2>Librarian</h2>
      <p className="muted small-text">
        The librarian has two jobs. <strong>Organise</strong> designs the layout of the whole wiki: which sections there are, what
        belongs in each (the summaries on the <a href="/structure">structure page</a>), and homes for what the watched folders show is
        still coming. <strong>Tidy</strong> cleans one section inside that layout: duplicates, stubs, misplaced pages and broken links.
        Everything it suggests waits for someone to approve it on the page.
      </p>
      {message && <div className={message.kind === 'ok' ? 'notice' : 'error'}>{message.text}</div>}
      {!data ? (
        !message && <p className="muted small-text">Loading</p>
      ) : (
        <>
          <label className="check small-text">
            <input
              type="checkbox"
              checked={data.settings.auto}
              disabled={busy === 'settings'}
              onChange={(e) => save({ auto: e.target.checked })}
            />{' '}
            Organise and tidy on its own after the wiki changes (once filing is done and nothing has changed for half an hour)
          </label>
          <div className="inline-field small-text">
            <label htmlFor="librarian-limit">Most pages changed per run</label>
            <input
              id="librarian-limit"
              type="number"
              min={1}
              max={data.maxLimit}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save({ limit: Number(limit) })}
            />
            <button
              className="btn small"
              disabled={busy === 'settings' || Number(limit) === data.settings.limit}
              onClick={() => save({ limit: Number(limit) })}
            >
              Save limit
            </button>
          </div>

          <ul className="sections">
            <li>
              <div className="section-name">
                <strong>The whole wiki</strong>
                <span className="muted small-text"> its sections and what belongs in each</span>
              </div>
              <button className="btn small" disabled={!!busy || !!data.whole.run} onClick={() => tidy(WHOLE, 'the whole wiki')}>
                {label(data.whole.run, busy === WHOLE, 'Organise')}
              </button>
            </li>
            {data.sections.map((s) => (
              <li key={s.section}>
                <div className="section-name">
                  <strong>{s.title}</strong>
                  <span className="muted small-text">
                    {' '}
                    {s.section}, {s.pages} page{s.pages === 1 ? '' : 's'}
                  </span>
                </div>
                <button className="btn small" disabled={!!busy || !!s.run} onClick={() => tidy(s.section, s.title)}>
                  {label(s.run, busy === s.section)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
