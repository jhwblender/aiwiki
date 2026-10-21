'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Md from './Md';

type Job = {
  id: number;
  displayName: string;
  folderLabel: string | null;
  relPath: string | null;
  user: string;
  status: 'queued' | 'working' | 'done' | 'skipped' | 'failed';
  detail: string | null;
  proposed: string[];
  createdAt: string;
  finishedAt: string | null;
};

const LABEL: Record<Job['status'], string> = { queued: 'Waiting', working: 'Reading', done: 'Done', skipped: 'Skipped', failed: 'Failed' };

function when(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

// Recent files filed in the background, with their outcome. Suggestions themselves are reviewed on the pages.
export default function BackgroundJobs() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/ingest', { cache: 'no-store' });
      setJobs(await r.json());
    } catch {
      setError('Could not load background activity.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh while anything is waiting or being read
  const active = !!jobs?.some((j) => j.status === 'queued' || j.status === 'working');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [active, load]);

  async function retry(id: number) {
    setError('');
    const r = await fetch(`/api/ingest/${id}/retry`, { method: 'POST' });
    if (!r.ok) setError((await r.json()).error || 'Could not try again.');
    load();
  }

  return (
    <section className="card" id="background">
      <h2>Background filing</h2>
      <p className="muted small-text">
        Files sent with &quot;File in the background&quot; are read one at a time. What they add shows up as suggestions on the pages, to
        approve there.
      </p>
      {error && <div className="error">{error}</div>}
      {!jobs ? (
        <p className="muted small-text">Loading</p>
      ) : jobs.length === 0 ? (
        <p className="muted small-text">Nothing has been filed in the background yet.</p>
      ) : (
        <ul className="jobs">
          {jobs.map((j) => (
            <li key={j.id} className={'job ' + j.status}>
              <span className="job-status">{LABEL[j.status]}</span>
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
              {j.status === 'failed' && (
                <button className="btn small" onClick={() => retry(j.id)}>
                  Try again
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
