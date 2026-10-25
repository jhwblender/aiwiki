import { db } from './db';
import { changed } from './pulse';
import { extractText, getFile } from './files';
import { getProvider } from './ai/providers';
import { checkVersion, recordVersion, type DocIdentity } from './ingest';
import { runAgent } from './ai/agent';
import { refileFiles } from './refile';
import { applyPatternRules, decide, looksLikeData, parsePlan, PLAN_SYSTEM, planOutline, storePlan } from './filingPlan';
import { AUTO_USER, librarianSettings, MAX_LIMIT, runName, scopeName, surveySection, tidyInstruction, WHOLE } from './librarian';

// Work done without anyone watching a chat: drops sent "in the background", files from watched
// folders, and librarian tidy runs over a section. One job runs at a time, oldest first, through
// the same assistant and suggestion path as the chat, so the result is suggestions on pages.

// kept: made searchable for lookups without running the assistant, by its folder's rule
export type JobStatus = 'queued' | 'working' | 'done' | 'kept' | 'skipped' | 'failed' | 'cancelled';

export type Job = {
  id: number;
  // file: filed by the assistant; index: personal, only made searchable; tidy: a librarian run;
  // plan: working out how a watched folder is filed
  kind: 'file' | 'index' | 'tidy' | 'plan';
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

// Work out how a watched folder is filed: patterns at once, then the assistant's plan in the queue
export function enqueuePlan(folder: { id: number; label: string; user: string }, provider?: string): number | null {
  applyPatternRules(folder.id);
  const key = `plan:${folder.label}`;
  if (db().prepare("SELECT 1 FROM ingest_jobs WHERE doc_key = ? AND status IN ('queued', 'working')").get(key)) return null;
  const r = db()
    .prepare(
      `INSERT INTO ingest_jobs (file_id, doc_key, display_name, folder_label, user, provider, mode, status, created_at)
       VALUES (NULL, ?, ?, ?, ?, ?, 'plan', 'queued', ?)`,
    )
    .run(key, `Plan for ${folder.label}`, folder.label, folder.user, provider ?? null, now());
  changed();
  kick();
  return Number(r.lastInsertRowid);
}

async function runPlan(row: any, signal: AbortSignal, onProgress: (text: string) => void) {
  const planStart = Date.now();
  console.log(`[plan] ${row.folder_label} starts`);
  const folder = db().prepare('SELECT id, label FROM watched_folders WHERE label = ?').get(row.folder_label) as { id: number; label: string } | undefined;
  if (!folder) return finish(row.id, 'skipped', 'The folder is no longer watched.');
  applyPatternRules(folder.id);
  onProgress('Looking at the folder tree');
  const provider = getProvider(row.provider ?? undefined);
  let text: string;
  try {
    const res = await provider.chat({
      system: PLAN_SYSTEM,
      messages: [{ role: 'user', content: `Watched folder "${folder.label}":\n${planOutline(folder.id)}` }],
      tools: [],
      signal,
    });
    text = res.text;
    console.log(`[plan] ${row.folder_label} provider answered in ${Date.now() - planStart} ms`);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    // Stopped: the model call was cut with the signal, so end as cancelled at once
    if (signal.aborted) return finish(row.id, 'cancelled', 'Stopped while it was planning. Rules and files are as they were.');
    if (MODEL_DOWN.test(msg)) throw new ModelDown(msg);
    throw e;
  }
  const plan = parsePlan(text, folder.id);
  if (!plan.size) return finish(row.id, 'done', 'The assistant gave no usable plan, so the folder follows the patterns found in it. You can set rules by hand.');
  const changed = storePlan(folder.id, plan);
  // Rules actually changed somewhere: files seen and skipped under there get looked at now
  let refiledNote = '';
  if (changed.length) {
    const refiled = await refileFiles(folder.id, changed);
    if (refiled) refiledNote = ` ${refiled} file${refiled === 1 ? '' : 's'} skipped before will be looked at again.`;
  }
  const lines = [...plan.entries()].map(([d, r]) => `- ${d === '.' ? '(top level)' : d}: ${r.rule}${r.reason ? `, ${r.reason}` : ''}`);
  finish(row.id, 'done', `Planned ${plan.size} folder${plan.size === 1 ? '' : 's'}:\n${lines.slice(0, 30).join('\n')}${refiledNote}`);
}

// A librarian run over one section, or the whole wiki (WHOLE). Only one per scope waits at a time.
export function enqueueTidy(input: { section: string; user: string; provider?: string; limit?: number }): number {
  const key = `tidy:${input.section}`;
  const waiting = db().prepare("SELECT id FROM ingest_jobs WHERE doc_key = ? AND status IN ('queued', 'working')").get(key);
  if (waiting) throw new Error(`${input.section === WHOLE ? 'Organising the wiki' : `A tidy of ${scopeName(input.section)}`} is already waiting or running.`);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(input.limit) || librarianSettings().limit)));
  const r = db()
    .prepare(
      `INSERT INTO ingest_jobs (file_id, doc_key, display_name, user, provider, mode, tidy_limit, status, created_at)
       VALUES (NULL, ?, ?, ?, ?, 'tidy', ?, 'queued', ?)`,
    )
    .run(key, runName(input.section), input.user, input.provider ?? null, limit, now());
  changed();
  kick();
  return Number(r.lastInsertRowid);
}

function rowToJob(r: any): Job {
  return {
    id: r.id,
    kind: r.mode,
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

// Plans first (they decide how the waiting files are handled), then librarian runs, then files
const RUN_ORDER = "(mode = 'plan') DESC, (mode = 'tidy') DESC, id ASC";

// Waiting jobs in the order they will run; everything else newest first, with the running job on top
export function listJobs(status?: JobStatus, limit = 50): Job[] {
  const rows = status
    ? db()
        .prepare(`SELECT * FROM ingest_jobs WHERE status = ? ORDER BY ${status === 'queued' ? RUN_ORDER : 'id DESC'} LIMIT ?`)
        .all(status, limit)
    : db().prepare("SELECT * FROM ingest_jobs ORDER BY (status = 'working') DESC, id DESC LIMIT ?").all(limit);
  return (rows as any[]).map(rowToJob);
}

export function jobCounts(): Record<JobStatus, number> {
  const out: Record<JobStatus, number> = { queued: 0, working: 0, done: 0, kept: 0, skipped: 0, failed: 0, cancelled: 0 };
  for (const r of db().prepare('SELECT status, COUNT(*) AS n FROM ingest_jobs GROUP BY status').all() as { status: JobStatus; n: number }[]) {
    out[r.status] = r.n;
  }
  return out;
}

// Waiting jobs per watched folder, so a whole folder's backlog can be cancelled
function waitingByFolder(): { folder: string | null; count: number }[] {
  return (
    db()
      .prepare("SELECT folder_label AS folder, COUNT(*) AS count FROM ingest_jobs WHERE status = 'queued' AND mode != 'tidy' GROUP BY folder_label")
      .all() as {
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

// Pausing lets the file being read finish, then stops before the next one; tidy runs still go
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

// A waiting job is cancelled at once; the running one's model call is cut the same way
export function cancelJob(id: number) {
  if (worker.current?.jobId === id) {
    // The in-flight model call is cut with the signal, so this ends at once; the run marks the
    // job cancelled as it unwinds
    worker.current.controller.abort();
    worker.current.status = 'Stopping';
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
        ? db().prepare(`${sql} AND folder_label IS NULL AND mode != 'tidy'`).run(now())
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

// Runs the assistant for a job; a stopped run is recorded as cancelled, an unreachable model waits
async function agentFor(row: any, signal: AbortSignal, run: () => ReturnType<typeof runAgent>) {
  try {
    return await run();
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (signal.aborted) {
      finish(row.id, 'cancelled', 'Stopped while it was running. Anything already suggested stays for review.');
      return null;
    }
    if (MODEL_DOWN.test(msg)) throw new ModelDown(msg);
    throw e;
  }
}

async function runTidy(row: any, signal: AbortSignal, onProgress: (text: string) => void) {
  const section = String(row.doc_key).slice('tidy:'.length);
  const limit = row.tidy_limit || librarianSettings().limit;
  onProgress(`Surveying ${scopeName(section)}`);
  const survey = await surveySection(section);
  if (!survey.pages) return finish(row.id, 'skipped', `There are no pages in "${section}".`);
  if (survey.pages === 1 && !survey.findings) return finish(row.id, 'skipped', `"${section}" has only one page and nothing to tidy.`);
  // The librarian's own runs only spend model time when the survey found something
  if (row.user === AUTO_USER && !survey.findings) return finish(row.id, 'skipped', `Nothing to tidy in ${scopeName(section)}.`);
  onProgress(`Found ${survey.findings} thing${survey.findings === 1 ? '' : 's'} to look at in ${survey.pages} pages`);
  const res = await agentFor(row, signal, () =>
    runAgent({
      history: [{ role: 'user', content: tidyInstruction(section, limit, survey.report) }],
      user: row.user,
      providerId: row.provider ?? undefined,
      librarian: { section, limit, organise: section === WHOLE },
      onProgress,
      signal,
    }),
  );
  if (!res) return;
  if (res.error) return finish(row.id, 'failed', res.error);
  const proposed = res.proposed.map((p) => p.path);
  finish(row.id, 'done', res.reply || (proposed.length ? 'Suggested changes.' : 'Nothing to tidy.'), proposed);
}

async function runJob(row: any, signal: AbortSignal, onProgress: (text: string) => void) {
  if (row.mode === 'tidy') return runTidy(row, signal, onProgress);
  if (row.mode === 'plan') return runPlan(row, signal, onProgress);
  // A file from a watched folder follows its folder's rule, decided when it comes up so waiting
  // files follow rules set after they were queued
  const rule = row.mode === 'file' && row.folder_label && row.rel_path ? decide(row.folder_label, row.rel_path) : null;
  if (rule?.action === 'skip') return finish(row.id, 'skipped', rule.why);
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
      await extractText(f, (image, prompt) => provider.describeImage(image, prompt, signal));
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
  if (rule?.action === 'index') {
    // Searchable for the assistant's lookups without running it. Photos and scans would need the
    // vision model just to be searchable, which is the cost a keep-searchable rule is there to avoid.
    if (f.kind === 'image') return finish(row.id, 'skipped', `${rule.why} Photos are only read when they are filed.`);
    try {
      await extractText(f, null);
    } catch (e: any) {
      return finish(row.id, 'skipped', `${rule.why} It could not be read without the model (${e?.message ?? e}).`);
    }
    recordVersion(identity, f, row.user, info);
    return finish(row.id, 'kept', rule.why);
  }
  // Read the file first, so a file that cannot be read fails (and can be tried again) instead of
  // being reported as filed, and an unreachable model makes the queue wait
  let text: string;
  try {
    const provider = getProvider(row.provider ?? undefined);
    text = (await extractText(f, (image, prompt) => provider.describeImage(image, prompt))).full;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (MODEL_DOWN.test(msg)) throw new ModelDown(msg);
    return finish(row.id, 'failed', `Could not read the file: ${msg}`);
  }
  // Raw readings and exports are not worth the assistant's time, wherever they sit
  if (f.kind === 'text' && looksLikeData(text)) {
    return finish(row.id, 'skipped', 'Looks like raw data (mostly numbers and symbols), so it was not read. Set its folder to file each document to read it anyway.');
  }
  const res = await agentFor(row, signal, () =>
    runAgent({
      history: [{ role: 'user', content: row.note || DEFAULT_NOTE }],
      user: row.user,
      providerId: row.provider ?? undefined,
      currentPath: row.current_path ?? undefined,
      attachments: [{ id: f.id, identity, info }],
      onProgress,
      signal,
    }),
  );
  if (!res) return;
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
        // A tidy run was asked for by someone waiting on it, so it goes before a backlog of files,
        // and pausing (which holds back files) does not hold it
        const onlyTidy = isPaused() ? "AND mode IN ('tidy', 'plan')" : '';
        const row = db().prepare(`SELECT * FROM ingest_jobs WHERE status = 'queued' ${onlyTidy} ORDER BY ${RUN_ORDER} LIMIT 1`).get() as any;
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
