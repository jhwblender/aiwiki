import { db } from './db';
import { changed } from './pulse';
import { extractText, getFile } from './files';
import { getProvider } from './ai/providers';
import { checkVersion, recordVersion, type DocIdentity } from './ingest';
import { runAgent } from './ai/agent';

// Files waiting to be filed into the wiki without anyone watching a chat: drops sent "in the
// background" and, next, files from watched folders. One job runs at a time, oldest first, through
// the same assistant and suggestion path as the chat, so the result is suggestions on pages.

export type JobStatus = 'queued' | 'working' | 'done' | 'skipped' | 'failed' | 'cancelled';

export type Job = {
  id: number;
  displayName: string;
  folderLabel: string | null;
  relPath: string | null;
  user: string;
  status: JobStatus;
  detail: string | null;
  proposed: string[];
  createdAt: string;
  finishedAt: string | null;
};

const DEFAULT_NOTE =
  'File the information from the attached document into the wiki. Put each fact on the page where it belongs, ' +
  'create a page only when nothing fits, and keep edits short. If there is nothing worth adding, say so.';

const now = () => new Date().toISOString();

// provider: the model picked in the chat; without one the first available model is used
export function enqueue(input: {
  fileId: number;
  identity: DocIdentity;
  user: string;
  note?: string;
  currentPath?: string;
  provider?: string;
  // index: only make the file searchable for its owner (personal folders); never suggests edits
  mode?: 'file' | 'index';
}): number {
  const r = db()
    .prepare(
      `INSERT INTO ingest_jobs (file_id, doc_key, display_name, folder_label, rel_path, user, note, current_path, provider, mode, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
    .run(
      input.fileId,
      input.identity.key,
      input.identity.displayName,
      input.identity.folderLabel ?? null,
      input.identity.relPath ?? null,
      input.user,
      input.note?.trim() || null,
      input.currentPath ?? null,
      input.provider ?? null,
      input.mode ?? 'file',
      now(),
    );
  kick();
  return Number(r.lastInsertRowid);
}

function rowToJob(r: any): Job {
  return {
    id: r.id,
    displayName: r.display_name,
    folderLabel: r.folder_label,
    relPath: r.rel_path,
    user: r.user,
    status: r.status,
    detail: r.detail,
    proposed: r.proposed ? JSON.parse(r.proposed) : [],
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

export function getJob(id: number): Job | null {
  const r = db().prepare('SELECT * FROM ingest_jobs WHERE id = ?').get(id);
  return r ? rowToJob(r) : null;
}

// Waiting jobs in the order they will run; everything else newest first, with the running job on top
export function listJobs(status?: JobStatus, limit = 50): Job[] {
  const rows = status
    ? db()
        .prepare(`SELECT * FROM ingest_jobs WHERE status = ? ORDER BY id ${status === 'queued' ? 'ASC' : 'DESC'} LIMIT ?`)
        .all(status, limit)
    : db().prepare("SELECT * FROM ingest_jobs ORDER BY (status = 'working') DESC, id DESC LIMIT ?").all(limit);
  return (rows as any[]).map(rowToJob);
}

export function jobCounts(): Record<JobStatus, number> {
  const out: Record<JobStatus, number> = { queued: 0, working: 0, done: 0, skipped: 0, failed: 0, cancelled: 0 };
  for (const r of db().prepare('SELECT status, COUNT(*) AS n FROM ingest_jobs GROUP BY status').all() as { status: JobStatus; n: number }[]) {
    out[r.status] = r.n;
  }
  return out;
}

// Waiting jobs per watched folder, so a whole folder's backlog can be cancelled
function waitingByFolder(): { folder: string | null; count: number }[] {
  return (
    db().prepare("SELECT folder_label AS folder, COUNT(*) AS count FROM ingest_jobs WHERE status = 'queued' GROUP BY folder_label").all() as {
      folder: string | null;
      count: number;
    }[]
  ).sort((a, b) => b.count - a.count);
}

// ---------- pausing ----------

export function isPaused(): boolean {
  const r = db().prepare("SELECT value FROM settings WHERE key = 'queue.paused'").get() as { value: string } | undefined;
  return r?.value === '1';
}

// Pausing lets the file being read finish, then stops before the next one
export function setPaused(paused: boolean) {
  db()
    .prepare("INSERT INTO settings (key, value) VALUES ('queue.paused', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(paused ? '1' : '0');
  changed();
  if (!paused) kick();
}

// ---------- cancelling and retrying ----------

export function retryJob(id: number) {
  const r = db()
    .prepare("UPDATE ingest_jobs SET status = 'queued', detail = NULL, finished_at = NULL WHERE id = ? AND status IN ('failed', 'cancelled')")
    .run(id);
  if (!r.changes) throw new Error('Only a job that failed or was cancelled can be tried again.');
  changed();
  kick();
}

export function retryFailed(): number {
  const n = db().prepare("UPDATE ingest_jobs SET status = 'queued', detail = NULL, finished_at = NULL WHERE status = 'failed'").run().changes;
  changed();
  kick();
  return n;
}

// A waiting job is cancelled at once; the running one stops after its current step
export function cancelJob(id: number) {
  if (worker.current?.jobId === id) {
    worker.current.controller.abort();
    worker.current.status = 'Stopping after this step';
    return;
  }
  const r = db()
    .prepare("UPDATE ingest_jobs SET status = 'cancelled', detail = 'Cancelled before it was read.', finished_at = ? WHERE id = ? AND status = 'queued'")
    .run(now(), id);
  if (!r.changes) throw new Error('Only a waiting or running job can be cancelled.');
  changed();
}

// folder: a watched folder label; null for files that were not from a folder; undefined for all
export function cancelWaiting(folder?: string | null): number {
  const sql = "UPDATE ingest_jobs SET status = 'cancelled', detail = 'Cancelled before it was read.', finished_at = ? WHERE status = 'queued'";
  const r =
    folder === undefined
      ? db().prepare(sql).run(now())
      : folder === null
        ? db().prepare(`${sql} AND folder_label IS NULL`).run(now())
        : db().prepare(`${sql} AND folder_label = ?`).run(now(), folder);
  changed();
  return r.changes;
}

function finish(id: number, status: JobStatus, detail: string, proposed: string[] = []) {
  db()
    .prepare('UPDATE ingest_jobs SET status = ?, detail = ?, proposed = ?, finished_at = ? WHERE id = ?')
    .run(status, detail.slice(0, 2000), JSON.stringify(proposed), now(), id);
  changed();
}

const day = (iso: string) => iso.slice(0, 10);

// The model server is not answering at all (as opposed to failing on one document)
const MODEL_DOWN = /Could not reach|Could not connect|Nothing is answering|fetch failed|ECONNREFUSED|ECONNRESET|was dropped|cannot be found\. Check the address/i;
class ModelDown extends Error {}

async function runJob(row: any, signal: AbortSignal, onProgress: (text: string) => void) {
  const f = getFile(row.file_id);
  if (!f) return finish(row.id, 'failed', 'The stored file is missing.');
  const personal = row.mode === 'index';
  const identity: DocIdentity = {
    key: row.doc_key,
    displayName: row.display_name,
    folderLabel: row.folder_label,
    relPath: row.rel_path,
    personal,
    owner: personal ? row.user : null,
  };
  const info = checkVersion(identity, f);
  // Nothing new: do not spend a model call on it
  if (info.status === 'unchanged') return finish(row.id, 'skipped', `Unchanged since ${day(info.previous!.at)}.`);
  if (personal) {
    // Personal folder: make it searchable for its owner, and nothing else
    try {
      const provider = getProvider(row.provider ?? undefined);
      await extractText(f, (image, prompt) => provider.describeImage(image, prompt));
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (MODEL_DOWN.test(msg)) throw new ModelDown(msg);
      return finish(row.id, 'failed', `Could not read the file: ${msg}`);
    }
    recordVersion(identity, f, row.user, info);
    return finish(row.id, 'done', `Kept for ${row.user}'s own searches. Nothing from it goes into the wiki.`);
  }
  // The same content already filed under another name or folder (a copy, a renamed subfolder, or
  // a folder watched inside another): it is in the wiki already
  if (info.duplicateOf) {
    // Remember this name too, so a later change to it is compared against this content
    recordVersion(identity, f, row.user, info);
    return finish(row.id, 'skipped', `Same content as "${info.duplicateOf.displayName}", added ${day(info.duplicateOf.at)}.`);
  }
  // Read the file first, so a file that cannot be read fails (and can be tried again) instead of
  // being reported as filed, and an unreachable model makes the queue wait
  try {
    const provider = getProvider(row.provider ?? undefined);
    await extractText(f, (image, prompt) => provider.describeImage(image, prompt));
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (MODEL_DOWN.test(msg)) throw new ModelDown(msg);
    return finish(row.id, 'failed', `Could not read the file: ${msg}`);
  }
  let res;
  try {
    res = await runAgent({
      history: [{ role: 'user', content: row.note || DEFAULT_NOTE }],
      user: row.user,
      providerId: row.provider ?? undefined,
      currentPath: row.current_path ?? undefined,
      attachments: [{ id: f.id, identity, info }],
      onProgress,
      signal,
    });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (signal.aborted) return finish(row.id, 'cancelled', 'Stopped while it was being read. Anything already suggested stays for review.');
    if (MODEL_DOWN.test(msg)) throw new ModelDown(msg);
    throw e;
  }
  if (res.error) return finish(row.id, 'failed', res.error);
  const proposed = res.proposed.map((p) => p.path);
  finish(row.id, 'done', res.reply || (proposed.length ? 'Suggested changes.' : 'Nothing to add.'), proposed);
}

// ---------- worker ----------

type Current = { jobId: number; steps: string[]; status: string; startedAt: string; controller: AbortController };
type Worker = {
  running: boolean;
  recovered: boolean;
  current: Current | null;
  // Set while the model cannot be reached: when the next attempt is and why
  waitUntil: number;
  waitReason: string;
  delay: number;
  wake: (() => void) | null;
};
const g = globalThis as unknown as { __ingestWorker?: Worker };
const worker: Worker = (g.__ingestWorker ??= { running: false, recovered: false, current: null, waitUntil: 0, waitReason: '', delay: 0, wake: null });
worker.current ??= null;
worker.waitUntil ??= 0;
worker.delay ??= 0;

const FIRST_DELAY = () => Math.max(1, Number(process.env.INGEST_RETRY_SECONDS) || 30) * 1000;
const MAX_DELAY = 10 * 60 * 1000;

export function queueState() {
  const c = worker.current;
  return {
    paused: isPaused(),
    waitingForModel: worker.waitUntil > Date.now() ? { until: new Date(worker.waitUntil).toISOString(), reason: worker.waitReason } : null,
    current: c ? { job: getJob(c.jobId), steps: c.steps, status: c.status, startedAt: c.startedAt } : null,
    counts: jobCounts(),
    waitingByFolder: waitingByFolder(),
  };
}

// Try the model again now instead of waiting out the delay
export function retryNow() {
  worker.waitUntil = 0;
  worker.wake?.();
  kick();
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      worker.wake = null;
      resolve();
    }
    worker.wake = done;
  });
}

export function kick() {
  if (worker.running) return;
  worker.running = true;
  void (async () => {
    try {
      if (!worker.recovered) {
        // Jobs that were mid-way when the server stopped start again
        db().prepare("UPDATE ingest_jobs SET status = 'queued' WHERE status = 'working'").run();
        worker.recovered = true;
      }
      for (;;) {
        if (isPaused()) break;
        const row = db().prepare("SELECT * FROM ingest_jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get() as any;
        if (!row) break;
        db().prepare("UPDATE ingest_jobs SET status = 'working', started_at = ? WHERE id = ?").run(now(), row.id);
        changed();
        const current: Current = { jobId: row.id, steps: [], status: 'Starting', startedAt: now(), controller: new AbortController() };
        worker.current = current;
        const onProgress = (text: string) => {
          if (/^Thinking/.test(text)) current.status = text;
          else {
            current.steps.push(text);
            if (current.steps.length > 200) current.steps.shift();
            current.status = 'Working';
          }
        };
        try {
          await runJob(row, current.controller.signal, onProgress);
          worker.delay = 0;
        } catch (e: any) {
          if (e instanceof ModelDown) {
            // Put the job back and wait, longer each time, instead of failing everything behind it
            db().prepare("UPDATE ingest_jobs SET status = 'queued', started_at = NULL WHERE id = ?").run(row.id);
            worker.delay = worker.delay ? Math.min(worker.delay * 2, MAX_DELAY) : FIRST_DELAY();
            worker.waitUntil = Date.now() + worker.delay;
            worker.waitReason = e.message;
            worker.current = null;
            changed();
            await sleep(worker.delay);
            worker.waitUntil = 0;
            continue;
          }
          finish(row.id, 'failed', e?.message ?? String(e));
        } finally {
          if (worker.current === current) worker.current = null;
        }
      }
    } finally {
      worker.running = false;
    }
  })();
}
