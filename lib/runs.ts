import crypto from 'node:crypto';
import { db } from './db';
import type { ChatResponse } from './types';

// A chat request runs on the server independently of the browser that sent it. Leaving the page,
// switching to another app on a phone, opening Settings or reloading does not stop it; the chat
// reconnects by run id and picks up the progress so far. Only Stop ends a run early. A run lives in
// memory while it works; once finished it is also saved, so the answer is still there when the
// person comes back hours later (kept a week). A restart of the wiki loses only runs still working.
// Only the person who started a run can follow or stop it.

export type RunEvent = { type: 'run'; id: string } | { type: 'progress'; text: string } | ({ type: 'done' } & ChatResponse) | { type: 'error'; error: string };

type Run = {
  id: string;
  owner: string;
  events: RunEvent[];
  finished: boolean;
  finishedAt: number | null;
  controller: AbortController;
  listeners: Set<(e: RunEvent) => void>;
};

// Finished runs stay in memory briefly for quick reconnects, and in the database for a week
const MEMORY_MS = 10 * 60 * 1000;
const KEEP_DAYS = 7;
const g = globalThis as unknown as { __chatRuns?: Map<string, Run> };
const runs = (g.__chatRuns ??= new Map());

// The browser may name the run itself, so it can find the run again even if the reply to its
// request never arrived (a phone that slept straight after sending)
const RUN_ID = /^[a-f0-9]{16,64}$/;

function prune() {
  const cutoff = Date.now() - MEMORY_MS;
  for (const [id, r] of runs) if (r.finished && (r.finishedAt ?? 0) < cutoff) runs.delete(id);
  db().prepare('DELETE FROM chat_runs WHERE finished_at < ?').run(new Date(Date.now() - KEEP_DAYS * 86400000).toISOString());
}

function known(id: string): boolean {
  return runs.has(id) || !!db().prepare('SELECT 1 FROM chat_runs WHERE id = ?').get(id);
}

export function startRun(owner: string, work: (onProgress: (text: string) => void, signal: AbortSignal) => Promise<ChatResponse>, wanted?: unknown): string {
  prune();
  const id = typeof wanted === 'string' && RUN_ID.test(wanted) && !known(wanted) ? wanted : crypto.randomBytes(12).toString('hex');
  const run: Run = { id, owner, events: [], finished: false, finishedAt: null, controller: new AbortController(), listeners: new Set() };
  runs.set(id, run);
  const emit = (e: RunEvent) => {
    run.events.push(e);
    for (const l of run.listeners) l(e);
  };
  emit({ type: 'run', id });
  void work((text) => emit({ type: 'progress', text }), run.controller.signal)
    .then((result) => emit({ type: 'done', ...result }))
    .catch((e) => emit({ type: 'error', error: e?.message ?? String(e) }))
    .finally(() => {
      run.finished = true;
      run.finishedAt = Date.now();
      run.listeners.clear();
      try {
        db()
          .prepare('INSERT OR REPLACE INTO chat_runs (id, owner, events, finished_at) VALUES (?, ?, ?, ?)')
          .run(id, owner, JSON.stringify(run.events), new Date(run.finishedAt).toISOString());
      } catch (e) {
        console.error('Could not save a finished chat reply', e);
      }
    });
  return id;
}

export function stopRun(id: string, owner: string): boolean {
  const r = runs.get(id);
  if (!r || r.finished || r.owner !== owner) return false;
  r.controller.abort();
  return true;
}

// A run that is working or finished, if it belongs to this person
function find(id: string, owner: string): Pick<Run, 'events' | 'finished' | 'listeners'> | null {
  const live = runs.get(id);
  if (live) return live.owner === owner ? live : null;
  const saved = db().prepare('SELECT events FROM chat_runs WHERE id = ? AND owner = ?').get(id, owner) as { events: string } | undefined;
  return saved ? { events: JSON.parse(saved.events), finished: true, listeners: new Set() } : null;
}

// Everything so far, then live events until the run finishes, as newline-delimited JSON
export function runStream(id: string, owner: string): Response | null {
  const r = find(id, owner);
  if (!r) return null;
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (e: RunEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
          if (e.type === 'done' || e.type === 'error') controller.close();
        } catch {
          unsubscribe();
        }
      };
      for (const e of r.events) send(e);
      if (r.finished) return;
      r.listeners.add(send);
      unsubscribe = () => r.listeners.delete(send);
    },
    cancel() {
      // The browser went away; the run itself carries on
      unsubscribe();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      // no-transform keeps the server from compressing (and so holding back) the progress lines
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
