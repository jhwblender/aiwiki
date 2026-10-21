import crypto from 'node:crypto';
import type { ChatResponse } from './types';

// A chat request runs on the server independently of the browser that sent it. Leaving the page,
// opening Settings or reloading does not stop it; the chat reconnects by run id and picks up the
// progress so far. Only Stop ends a run early. Runs live in memory and are forgotten an hour after
// they finish (a restart of the wiki also forgets them).

export type RunEvent = { type: 'run'; id: string } | { type: 'progress'; text: string } | ({ type: 'done' } & ChatResponse) | { type: 'error'; error: string };

type Run = {
  id: string;
  events: RunEvent[];
  finished: boolean;
  finishedAt: number | null;
  controller: AbortController;
  listeners: Set<(e: RunEvent) => void>;
};

const KEEP_MS = 60 * 60 * 1000;
const g = globalThis as unknown as { __chatRuns?: Map<string, Run> };
const runs = (g.__chatRuns ??= new Map());

function prune() {
  const cutoff = Date.now() - KEEP_MS;
  for (const [id, r] of runs) if (r.finished && (r.finishedAt ?? 0) < cutoff) runs.delete(id);
}

export function startRun(work: (onProgress: (text: string) => void, signal: AbortSignal) => Promise<ChatResponse>): string {
  prune();
  const id = crypto.randomBytes(12).toString('hex');
  const run: Run = { id, events: [], finished: false, finishedAt: null, controller: new AbortController(), listeners: new Set() };
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
    });
  return id;
}

export function stopRun(id: string): boolean {
  const r = runs.get(id);
  if (!r || r.finished) return false;
  r.controller.abort();
  return true;
}

// Everything so far, then live events until the run finishes, as newline-delimited JSON
export function runStream(id: string): Response | null {
  const r = runs.get(id);
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
