'use client';
import { useCallback, useEffect, useState } from 'react';

type Run = 'queued' | 'working' | null;
type Section = { section: string; title: string; pages: number; run: Run };
type Schedule = { days: number[]; from: number; to: number; quietMinutes: number; wholeHours: number; sectionHours: number };
type Data = {
  sections: Section[];
  whole: { run: Run };
  settings: { limit: number; auto: boolean; schedule: Schedule };
  maxLimit: number;
  clock: { day: number; hour: number; minute: number };
  inSchedule: boolean;
};
// The schedule being edited; numbers stay as typed until saved
type Draft = { days: number[]; from: number; to: number; quietMinutes: string; wholeHours: string; sectionHours: string };

const WHOLE = '*';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;
const toDraft = (s: Schedule): Draft => ({ ...s, quietMinutes: String(s.quietMinutes), wholeHours: String(s.wholeHours), sectionHours: String(s.sectionHours) });
const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

// The librarian keeps the wiki organised. It runs on its own after the wiki changes, and any part can
// be tidied now. Runs go through background filing, and what they suggest is reviewed on the pages.
export default function Librarian() {
  const [data, setData] = useState<Data | null>(null);
  const [limit, setLimit] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/librarian', { cache: 'no-store' });
      const d: Data = await r.json();
      setData(d);
      setLimit((cur) => cur || String(d.settings.limit));
      setDraft((cur) => cur ?? toDraft(d.settings.schedule));
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
    let provider = '';
    try {
      provider = localStorage.getItem('wiki-provider') || '';
    } catch {}
    try {
      const r = await fetch('/api/librarian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, provider: provider || undefined }),
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

  async function save(change: { limit?: number; auto?: boolean; schedule?: Partial<Schedule> }) {
    setBusy('settings');
    setMessage(null);
    try {
      const r = await fetch('/api/librarian', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not save.');
      setLimit(String(d.limit));
      if (change.schedule) setDraft(toDraft(d.schedule));
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
        belongs in each (the summaries on the <a href="/wiki/index#contents">contents on the home page</a>), and homes for what the watched folders show is
        still coming. <strong>Tidy</strong> cleans one section inside that layout: duplicates, stubs, misplaced pages and broken links.
        Everything it suggests waits for someone to approve it on the page. A run someone starts covers the pages they can edit; the
        librarian&apos;s own runs cover only pages open to everyone.
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
            Organise and tidy on its own after the wiki changes, once filing is done. A part with no changes since its last run is left
            alone.
          </label>
          {draft && (
            <fieldset className="visibility lib-schedule" disabled={busy === 'settings'}>
              <legend>When it runs on its own</legend>
              <div className="day-picks small-text">
                {WEEK.map((d) => (
                  <label key={d} className="check">
                    <input
                      type="checkbox"
                      checked={draft.days.includes(d)}
                      onChange={(e) => setDraft({ ...draft, days: e.target.checked ? [...draft.days, d].sort() : draft.days.filter((x) => x !== d) })}
                    />{' '}
                    {DAY_NAMES[d].slice(0, 3)}
                  </label>
                ))}
              </div>
              <div className="inline-field small-text">
                <label htmlFor="librarian-from">From</label>
                <select id="librarian-from" value={draft.from} onChange={(e) => setDraft({ ...draft, from: Number(e.target.value) })}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{hour(h)}</option>
                  ))}
                </select>
                <label htmlFor="librarian-to">to</label>
                <select id="librarian-to" value={draft.to} onChange={(e) => setDraft({ ...draft, to: Number(e.target.value) })}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{hour(h)}</option>
                  ))}
                </select>
              </div>
              <p className="muted small-text schedule-note">
                The same start and end means any time of day; an end before the start runs overnight. Times follow the server&apos;s clock,
                now {DAY_NAMES[data.clock.day]} {String(data.clock.hour).padStart(2, '0')}:{String(data.clock.minute).padStart(2, '0')}
                {data.settings.auto && !data.inSchedule ? ', outside these hours.' : '.'}
              </p>
              <div className="inline-field small-text">
                <label htmlFor="librarian-quiet">Wait after the last change (minutes)</label>
                <input id="librarian-quiet" type="number" min={0} max={1440} value={draft.quietMinutes} onChange={(e) => setDraft({ ...draft, quietMinutes: e.target.value })} />
              </div>
              <div className="inline-field small-text">
                <label htmlFor="librarian-whole">Organise the whole wiki at most every (hours)</label>
                <input id="librarian-whole" type="number" min={0} max={720} value={draft.wholeHours} onChange={(e) => setDraft({ ...draft, wholeHours: e.target.value })} />
              </div>
              <div className="inline-field small-text">
                <label htmlFor="librarian-section">Tidy each section at most every (hours)</label>
                <input id="librarian-section" type="number" min={0} max={720} value={draft.sectionHours} onChange={(e) => setDraft({ ...draft, sectionHours: e.target.value })} />
              </div>
              <div className="inline-field small-text">
                <button
                  className="btn small"
                  disabled={sameDraft(draft, toDraft(data.settings.schedule))}
                  onClick={() =>
                    save({
                      schedule: {
                        ...draft,
                        quietMinutes: Number(draft.quietMinutes),
                        wholeHours: Number(draft.wholeHours),
                        sectionHours: Number(draft.sectionHours),
                      },
                    })
                  }
                >
                  Save schedule
                </button>
                <button
                  className="btn small quiet"
                  disabled={sameDraft(draft, toDraft(data.settings.schedule))}
                  onClick={() => setDraft(toDraft(data.settings.schedule))}
                >
                  Undo changes
                </button>
              </div>
            </fieldset>
          )}
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
