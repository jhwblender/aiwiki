'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Md from './Md';

type Status = 'queued' | 'working' | 'done' | 'skipped' | 'failed' | 'cancelled';
type Job = {
  id: number;
  kind: 'file' | 'index' | 'tidy';
  displayName: string;
  folderLabel: string | null;
  relPath: string | null;
  user: string;
  status: Status;
  detail: string | null;
  proposed: string[];
  createdAt: string;
  finishedAt: string | null;
};
type State = {
  paused: boolean;
  waitingForModel: { until: string; reason: string } | null;
  current: { job: Job | null; steps: string[]; status: string; startedAt: string } | null;
  counts: Record<Status, number>;
  waitingByFolder: { folder: string | null; count: number }[];
  jobs: Job[];
};

const LABEL: Record<Status, string> = {
  queued: 'Waiting',
  working: 'Reading',
  done: 'Done',
  skipped: 'Skipped',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const FILTERS: Status[] = ['queued', 'done', 'skipped', 'failed', 'cancelled'];

function when(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function elapsed(fromIso: string, now: number) {
  const s = Math.max(0, Math.round((now - new Date(fromIso).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Background filing: what is running and what it is doing, what is waiting, and controls to pause,
// cancel and retry. Suggestions themselves are reviewed on the pages.
export default function BackgroundJobs() {
  const [state, setState] = useState<State | null>(null);
  const [filter, setFilter] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/ingest${filter ? `?status=${filter}` : ''}`, { cache: 'no-store' });
      setState(await r.json());
      setNow(Date.now());
    } catch {
      setError('Could not load background activity.');
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh often while something is running or waiting, rarely otherwise
  const active = !!state && (state.counts.working > 0 || (state.counts.queued > 0 && !state.paused));
  useEffect(() => {
    const t = setInterval(load, active ? 2000 : 10000);
    return () => clearInterval(t);
  }, [active, load]);

  async function act(url: string, body?: object) {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) setError((await r.json()).error || 'That did not work.');
    } finally {
      setBusy(false);
      load();
    }
  }
  const control = (action: string, extra: object = {}) => act('/api/ingest/control', { action, ...extra });

  const c = state?.counts;
  const cur = state?.current;

  return (
    <section className="card" id="background">
      <h2>Background filing</h2>
      <p className="muted small-text">
        Files from watched folders, &quot;File in the background&quot; and librarian tidy runs are handled one at a time. What they suggest
        shows up on the pages, to approve there.
      </p>
      {error && <div className="error">{error}</div>}

      {state && (
        <>
          <div className="queue-bar">
            <span className="small-text">
              {state.paused ? (
                <strong>Paused.</strong>
              ) : c!.working ? (
                <strong>Running.</strong>
              ) : c!.queued ? (
                <strong>Starting.</strong>
              ) : (
                <strong>Idle.</strong>
              )}{' '}
              {c!.queued} waiting
            </span>
            <span className="spacer" />
            {state.paused ? (
              <button className="btn small primary" disabled={busy} onClick={() => control('resume')}>
                Resume
              </button>
            ) : (
              <button className="btn small" disabled={busy} onClick={() => control('pause')}>
                Pause
              </button>
            )}
          </div>
          {state.paused && (
            <p className="muted small-text">
              {c!.working > 0 ? 'The file being read finishes first, then filing stops. ' : ''}Tidy runs from the librarian still run while
              filing is paused.
            </p>
          )}

          {state.waitingForModel && (
            <div className="notice queue-wait">
              <div>
                The model cannot be reached, so filing is waiting rather than failing every file. Next try{' '}
                {new Date(state.waitingForModel.until).toLocaleTimeString(undefined, { timeStyle: 'short' })}.
                <div className="small-text muted">{state.waitingForModel.reason}</div>
              </div>
              <button className="btn small" disabled={busy} onClick={() => control('retry-now')}>
                Try now
              </button>
            </div>
          )}

          {cur?.job && (
            <div className="job-live" aria-live="polite">
              <div className="live-head">
                <span className="live-dot" aria-hidden="true" />
                <span>
                  {cur.status} on <strong>{cur.job.displayName}</strong> for {elapsed(cur.startedAt, now)}
                </span>
                <span className="spacer" />
                <button className="btn quiet small" disabled={busy} onClick={() => act(`/api/ingest/${cur.job!.id}/cancel`)}>
                  Stop
                </button>
              </div>
              {cur.job.folderLabel && (
                <div className="muted small-text">
                  {cur.job.folderLabel}
                  {cur.job.relPath ? ` / ${cur.job.relPath}` : ''}
                </div>
              )}
              {cur.steps.length > 0 ? (
                <ol className="live-steps">
                  {cur.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              ) : (
                <p className="small-text muted">
                  {cur.job.kind === 'tidy'
                    ? 'Looking over the section and waiting for the model.'
                    : 'Reading the file and waiting for the model. Large files on a local model can take several minutes.'}
                </p>
              )}
            </div>
          )}

          <div className="queue-filters" role="tablist" aria-label="Show">
            <button
              role="tab"
              aria-selected={!filter}
              className={'btn small' + (!filter ? ' picked' : ' quiet')}
              onClick={() => setFilter(null)}
            >
              Recent
            </button>
            {FILTERS.map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                className={'btn small' + (filter === f ? ' picked' : ' quiet')}
                onClick={() => setFilter(f)}
              >
                {LABEL[f]} {c![f]}
              </button>
            ))}
          </div>

          {filter === 'queued' && c!.queued > 0 && (
            <div className="queue-actions">
              {state.waitingByFolder.length > 1 &&
                state.waitingByFolder.map((w) => (
                  <button
                    key={w.folder ?? '(none)'}
                    className="btn small quiet"
                    disabled={busy}
                    onClick={() => {
                      const name = w.folder ? `"${w.folder}"` : 'dropped files';
                      if (window.confirm(`Cancel the ${w.count} waiting files from ${name}? They are not read.`)) {
                        control('cancel-waiting', { folder: w.folder });
                      }
                    }}
                  >
                    Cancel {w.count} from {w.folder ?? 'dropped files'}
                  </button>
                ))}
              <button
                className="btn small"
                disabled={busy}
                onClick={() => window.confirm(`Cancel all ${c!.queued} waiting files? They are not read.`) && control('cancel-waiting')}
              >
                Cancel all waiting
              </button>
            </div>
          )}
          {filter === 'failed' && c!.failed > 0 && (
            <div className="queue-actions">
              <button className="btn small" disabled={busy} onClick={() => control('retry-failed')}>
                Try all {c!.failed} again
              </button>
            </div>
          )}

          {state.jobs.length === 0 ? (
            <p className="muted small-text">
              {filter ? `Nothing ${LABEL[filter].toLowerCase()}.` : 'Nothing has been filed in the background yet.'}
            </p>
          ) : (
            <ul className="jobs">
              {state.jobs.map((j) => (
                <li key={j.id} className={'job ' + j.status}>
                  <span className="job-status">{j.kind === 'tidy' && j.status === 'working' ? 'Tidying' : LABEL[j.status]}</span>
                  <div className="job-body">
                    <strong>{j.displayName}</strong>
                    <span className="muted small-text">
                      {' '}
                      {j.folderLabel ? `${j.folderLabel}${j.relPath ? ` / ${j.relPath}` : ''}, ` : ''}from {j.user}, {when(j.createdAt)}
                    </span>
                    {j.detail && (
                      <div className="small-text job-detail">
                        <Md>{j.detail}</Md>
                      </div>
                    )}
                    {j.proposed.length > 0 && (
                      <div className="small-text">
                        Suggestions on:{' '}
                        {j.proposed.map((p, i) => (
                          <span key={p}>
                            {i > 0 && ', '}
                            <Link href={`/wiki/${p}`}>{p}</Link>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {j.status === 'queued' && (
                    <button className="btn small quiet" disabled={busy} onClick={() => act(`/api/ingest/${j.id}/cancel`)}>
                      Cancel
                    </button>
                  )}
                  {(j.status === 'failed' || j.status === 'cancelled') && (
                    <button className="btn small" disabled={busy} onClick={() => act(`/api/ingest/${j.id}/retry`)}>
                      Try again
                    </button>
                  )}
                </li>
              ))}
              {filter && c![filter] > state.jobs.length && (
                <li className="muted small-text">And {c![filter] - state.jobs.length} more not shown.</li>
              )}
            </ul>
          )}
        </>
      )}
      {!state && !error && <p className="muted small-text">Loading</p>}
    </section>
  );
}
