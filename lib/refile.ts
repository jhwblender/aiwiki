import path from 'node:path';
import fs from 'node:fs/promises';
import { db } from './db';
import { decide } from './filingPlan';
import { saveUpload } from './files';
import { enqueue } from './queue';

// Re-evaluate the files under a folder after its rule changed. Files that were once seen and
// skipped never reach the queue again on their own: a later scan sees the same content hash and
// moves on before any rule is consulted. So whenever a rule actually changes - a person's pick,
// the assistant's replan, or a pattern taking over - every readable file under that part of the
// folder is read now if it was never read, and queued again if its content has nothing on file.
// Returns how many files were queued.

// Kept out of filingPlan (it would import the queue, and the queue imports filingPlan).
export async function refileFiles(folderId: number, dirs: string[]): Promise<number> {
  if (!dirs.length) return 0;
  const d = db();
  const folder = d.prepare('SELECT * FROM watched_folders WHERE id = ?').get(folderId) as any;
  if (!folder || !folder.enabled) return 0;
  const prefixes = dirs.filter((x) => x !== '.').map((x) => `${x}/`);
  const covers = (rel: string) => dirs.includes('.') || prefixes.some((p) => rel.startsWith(p));
  const rows = (d.prepare('SELECT rel_path, hash FROM watched_files WHERE folder_id = ?').all(folderId) as { rel_path: string; hash: string }[]).filter((r) =>
    covers(r.rel_path),
  );
  let queued = 0;
  for (const r of rows) {
    const personal = folder.visibility === 'personal';
    const identity = {
      key: `${personal ? 'personal' : 'folder'}:${folder.label}:${r.rel_path}`,
      displayName: path.basename(r.rel_path),
      folderLabel: folder.label,
      relPath: r.rel_path,
      personal,
      owner: personal ? folder.user : null,
    };
    // Reconsidering re-queues only files that ended up not considered: nothing queued yet, or a
    // job that ended skipped (by a rule then, or for being a duplicate), kept for searching, or
    // cancelled. Files queued or working now are on their way - re-adding them would read them
    // twice - and files already filed stay filed. (Failed ones have their own retry.)
    const last = d.prepare('SELECT status FROM ingest_jobs WHERE doc_key = ? ORDER BY id DESC LIMIT 1').get(identity.key) as { status: string } | undefined;
    if (last && !['skipped', 'kept', 'cancelled'].includes(last.status)) continue;
    // The rule that covers it now decides what happens at run time; only a skip spares it the read
    const action = decide(folder.label, r.rel_path);
    if (action.action === 'skip') continue;
    // Already waiting to be filed
    if (d.prepare("SELECT 1 FROM ingest_jobs WHERE doc_key = ? AND status IN ('queued', 'working')").get(identity.key)) continue;
    try {
      const data = await fs.readFile(path.join(folder.path, r.rel_path));
      const stored = await saveUpload(identity.displayName, data, folder.user);
      // file-mode, so the rule decides at run time exactly as for files the scan queues itself
      enqueue({ fileId: stored.id, identity, user: folder.user, mode: personal ? 'index' : 'file' });
      queued++;
    } catch {
      // unreadable since it was seen; the next scan records why
    }
  }
  return queued;
}