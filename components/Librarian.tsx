'use client';
import { useCallback, useEffect, useState } from 'react';

type Section = { section: string; title: string; pages: number; run: 'queued' | 'working' | null };

// Start a librarian tidy run per section. Runs go through background filing, and what they
// suggest is reviewed on the pages like any other suggestion.
export default function Librarian() {
  const [sections, setSections] = useState<Section[] | null>(null);
  const [limit, setLimit] = useState(5);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/librarian', { cache: 'no-store' });
      const d = await r.json();
      setSections(d.sections);
      setLimit(d.limit);
    } catch {
      setMessage({ kind: 'error', text: 'Could not load the sections.' });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the buttons in step while a run is waiting or running
  const active = !!sections?.some((s) => s.run);
  useEffect(() => {
    const t = setInterval(load, active ? 3000 : 15000);
    return () => clearInterval(t);
  }, [active, load]);

  async function tidy(s: Section) {
    setBusy(s.section);
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
        body: JSON.stringify({ section: s.section, user, provider: provider || undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'The tidy could not start.');
      setMessage({ kind: 'ok', text: `Tidying ${s.title}. Follow it under Background filing; its suggestions appear on the pages for review.` });
    } catch (e: any) {
      setMessage({ kind: 'error', text: e.message });
    } finally {
      setBusy('');
      load();
    }
  }

  return (
    <section className="card" id="librarian">
      <h2>Librarian</h2>
      <p className="muted small-text">
        The librarian looks over one section for duplicate pages, pages in the wrong place, missing overview pages and broken links, and
        suggests up to {limit} fixes per run. Nothing changes until someone approves it on the page. You can also ask the assistant in the
        chat to tidy a section.
      </p>
      {message && <div className={message.kind === 'ok' ? 'notice' : 'error'}>{message.text}</div>}
      {!sections ? (
        !message && <p className="muted small-text">Loading</p>
      ) : sections.length === 0 ? (
        <p className="muted small-text">There is nothing to tidy yet; the wiki only has its home page.</p>
      ) : (
        <ul className="sections">
          {sections.map((s) => (
            <li key={s.section}>
              <div className="section-name">
                <strong>{s.title}</strong>
                <span className="muted small-text">
                  {' '}
                  {s.section}, {s.pages} page{s.pages === 1 ? '' : 's'}
                </span>
              </div>
              <button className="btn small" disabled={!!busy || !!s.run} onClick={() => tidy(s)}>
                {s.run === 'working' ? 'Tidying' : s.run === 'queued' ? 'Waiting' : busy === s.section ? 'Starting' : 'Tidy'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
