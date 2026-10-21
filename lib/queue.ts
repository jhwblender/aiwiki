import { db } from './db';
import { changed } from './pulse';
import { getFile } from './files';
import { checkVersion, recordVersion, type DocIdentity } from './ingest';
import { runAgent } from './ai/agent';

// Files waiting to be filed into the wiki without anyone watching a chat: drops sent "in the
// background" and, next, files from watched folders. One job runs at a time, oldest first, through
// the same assistant and suggestion path as the chat, so the result is suggestions on pages.

export type JobStatus = 'queued' | 'working' | 'done' | 'skipped' | 'failed';

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
}): number {
  const r = db()
    .prepare(
      `INSERT INTO ingest_jobs (file_id, doc_key, display_name, folder_label, rel_path, user, note, current_path, provider, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
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

export function recentJobs(limit = 30): Job[] {
  return (db().prepare('SELECT * FROM ingest_jobs ORDER BY id DESC LIMIT ?').all(limit) as any[]).map(rowToJob);
}

export function getJob(id: number): Job | null {
  const r = db().prepare('SELECT * FROM ingest_jobs WHERE id = ?').get(id);
  return r ? rowToJob(r) : null;
}

export function retryJob(id: number) {
  const r = db().prepare("UPDATE ingest_jobs SET status = 'queued', detail = NULL, finished_at = NULL WHERE id = ? AND status = 'failed'").run(id);
  if (!r.changes) throw new Error('Only a job that failed can be tried again.');
  kick();
}

function finish(id: number, status: JobStatus, detail: string, proposed: string[] = []) {
  changed();
  db()
    .prepare('UPDATE ingest_jobs SET status = ?, detail = ?, proposed = ?, finished_at = ? WHERE id = ?')
    .run(status, detail.slice(0, 2000), JSON.stringify(proposed), now(), id);
}

const day = (iso: string) => iso.slice(0, 10);

async function runJob(row: any) {
  const f = getFile(row.file_id);
  if (!f) return finish(row.id, 'failed', 'The stored file is missing.');
  const identity: DocIdentity = { key: row.doc_key, displayName: row.display_name, folderLabel: row.folder_label, relPath: row.rel_path };
  const info = checkVersion(identity, f);
  // Nothing new: do not spend a model call on it
  if (info.status === 'unchanged') return finish(row.id, 'skipped', `Unchanged since ${day(info.previous!.at)}.`);
  // The same content already filed under another name or folder (a copy, a renamed subfolder, or
  // a folder watched inside another): it is in the wiki already
  if (info.duplicateOf) {
    // Remember this name too, so a later change to it is compared against this content
    recordVersion(identity, f, row.user, info);
    return finish(row.id, 'skipped', `Same content as "${info.duplicateOf.displayName}", added ${day(info.duplicateOf.at)}.`);
  }
  const res = await runAgent({
    history: [{ role: 'user', content: row.note || DEFAULT_NOTE }],
    user: row.user,
    providerId: row.provider ?? undefined,
    currentPath: row.current_path ?? undefined,
    attachments: [{ id: f.id, identity, info }],
  });
  if (res.error) return finish(row.id, 'failed', res.error);
  const proposed = res.proposed.map((p) => p.path);
  finish(row.id, 'done', res.reply || (proposed.length ? 'Suggested changes.' : 'Nothing to add.'), proposed);
}

// ---------- worker ----------

const g = globalThis as unknown as { __ingestWorker?: { running: boolean; recovered: boolean } };
const worker = (g.__ingestWorker ??= { running: false, recovered: false });

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
        const row = db().prepare("SELECT * FROM ingest_jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get() as any;
        if (!row) break;
        db().prepare("UPDATE ingest_jobs SET status = 'working', started_at = ? WHERE id = ?").run(now(), row.id);
        try {
          await runJob(row);
        } catch (e: any) {
          finish(row.id, 'failed', e?.message ?? String(e));
        }
      }
    } finally {
      worker.running = false;
    }
  })();
}
