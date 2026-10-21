import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from './db';
import { MAX_FILE_BYTES, saveUpload } from './files';
import { enqueue } from './queue';

// Folders on the server's disk that feed the wiki. Every scan walks each enabled folder, and a
// file that is new or whose content changed goes to the ingest queue as a version of a document
// identified by the folder label and its path inside the folder. Nothing is ever written to the folder.

export type WatchedFolder = {
  id: number;
  label: string;
  path: string;
  user: string;
  enabled: boolean;
  lastScanAt: string | null;
  lastError: string | null;
  fileCount: number;
  insideOf: string | null; // label of a watched folder that contains this one
  contains: string[]; // labels of watched folders inside this one, whose files they own
};

const SUPPORTED = new Set(['.pdf', '.docx', '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
const SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information']);
const MAX_DEPTH = 8;
const MAX_FILES = 5000;
// A file changed this recently may still be copying or syncing; wait for the next scan
const SETTLE_MS = 10_000;

const now = () => new Date().toISOString();

function rowToFolder(r: any): WatchedFolder {
  return {
    id: r.id,
    label: r.label,
    path: r.path,
    user: r.user,
    enabled: !!r.enabled,
    lastScanAt: r.last_scan_at,
    lastError: r.last_error,
    fileCount: r.file_count ?? 0,
    insideOf: null,
    contains: [],
  };
}

const inside = (child: string, parent: string) => child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

// Watched folders that sit inside this one (the innermost folder owns its files)
function nestedInside(dir: string, id: number): Set<string> {
  const all = db().prepare('SELECT id, path FROM watched_folders').all() as { id: number; path: string }[];
  return new Set(all.filter((f) => f.id !== id && inside(f.path, dir)).map((f) => f.path));
}

export function listFolders(): WatchedFolder[] {
  const rows = (
    db()
      .prepare('SELECT f.*, (SELECT COUNT(*) FROM watched_files w WHERE w.folder_id = f.id) AS file_count FROM watched_folders f ORDER BY f.label')
      .all() as any[]
  ).map(rowToFolder);
  for (const f of rows) {
    const parents = rows.filter((o) => o.id !== f.id && inside(f.path, o.path)).sort((a, b) => b.path.length - a.path.length);
    f.insideOf = parents[0]?.label ?? null;
    f.contains = rows.filter((o) => o.id !== f.id && inside(o.path, f.path)).map((o) => o.label);
  }
  return rows;
}

// Point a folder at its new location after it was renamed or moved. Its documents keep their
// identity (label and path inside the folder), so nothing already filed is filed again.
export async function changeFolderPath(id: number, newPath: string) {
  const dir = path.resolve(fromWindowsPath(newPath.trim()));
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    throw new Error(`The wiki server cannot find the folder ${dir}.`);
  }
  if (!stat.isDirectory()) throw new Error(`${dir} is a file, not a folder.`);
  const same = db().prepare('SELECT label FROM watched_folders WHERE path = ? AND id != ?').get(dir, id) as { label: string } | undefined;
  if (same) throw new Error(`That folder is already watched as "${same.label}".`);
  db().prepare('UPDATE watched_folders SET path = ?, last_error = NULL WHERE id = ?').run(dir, id);
}

// A Windows path pasted in while the wiki runs in WSL: C:\Users\me\Docs -> /mnt/c/Users/me/Docs
function fromWindowsPath(p: string): string {
  const m = p.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (!m || process.platform === 'win32') return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

export async function addFolder(input: { label: string; path: string; user: string; fileExisting: boolean }): Promise<WatchedFolder> {
  const label = input.label.trim().slice(0, 80);
  if (!label) throw new Error('Give the folder a label, for example "Systems SharePoint".');
  const dir = path.resolve(fromWindowsPath(input.path.trim()));
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    throw new Error(`The wiki server cannot find the folder ${dir}.`);
  }
  if (!stat.isDirectory()) throw new Error(`${dir} is a file, not a folder.`);
  if (db().prepare('SELECT 1 FROM watched_folders WHERE label = ?').get(label)) throw new Error(`A folder is already labelled "${label}".`);
  const same = db().prepare('SELECT label FROM watched_folders WHERE path = ?').get(dir) as { label: string } | undefined;
  if (same) throw new Error(`That folder is already watched as "${same.label}".`);
  const r = db()
    .prepare('INSERT INTO watched_folders (label, path, user, enabled, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(label, dir, input.user, now());
  const id = Number(r.lastInsertRowid);
  // Without filing what is already there, the first scan only records the files as seen
  await scanFolder(id, { baselineOnly: !input.fileExisting });
  return rowToFolder({ ...(db().prepare('SELECT * FROM watched_folders WHERE id = ?').get(id) as any), file_count: countFiles(id) });
}

function countFiles(id: number) {
  return (db().prepare('SELECT COUNT(*) AS n FROM watched_files WHERE folder_id = ?').get(id) as { n: number }).n;
}

export function setEnabled(id: number, enabled: boolean) {
  db().prepare('UPDATE watched_folders SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

export function removeFolder(id: number) {
  const d = db();
  d.prepare('DELETE FROM watched_files WHERE folder_id = ?').run(id);
  d.prepare('DELETE FROM watched_folders WHERE id = ?').run(id);
}

// skip: other watched folders inside this one; their files belong to them
async function walk(root: string, skip: Set<string>): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string, depth: number) {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    if (depth > 0 && skip.has(dir)) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // Hidden files and Office lock files (~$report.docx) are never documents
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) await visit(full, depth + 1);
      } else if (e.isFile() && SUPPORTED.has(path.extname(e.name).toLowerCase())) {
        out.push(full);
        if (out.length >= MAX_FILES) return;
      }
    }
  }
  await visit(root, 0);
  return out;
}

// Look for new and changed files in one folder. Returns how many were sent to the queue.
export async function scanFolder(id: number, opts: { baselineOnly?: boolean } = {}): Promise<number> {
  const d = db();
  const folder = d.prepare('SELECT * FROM watched_folders WHERE id = ?').get(id) as any;
  if (!folder) throw new Error('Folder not found.');
  let queued = 0;
  try {
    // A folder that was renamed, moved or disconnected must not look like an empty one
    try {
      if (!(await fs.stat(folder.path)).isDirectory()) throw new Error();
    } catch {
      throw new Error('The folder can no longer be found. It may have been renamed, moved or disconnected; use Change folder to point to it again.');
    }
    const files = await walk(folder.path, nestedInside(folder.path, id));
    for (const full of files) {
      const rel = path.relative(folder.path, full).split(path.sep).join('/');
      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (Date.now() - st.mtimeMs < SETTLE_MS) continue;
      const seen = d.prepare('SELECT size, mtime_ms, hash FROM watched_files WHERE folder_id = ? AND rel_path = ?').get(id, rel) as
        | { size: number; mtime_ms: number; hash: string }
        | undefined;
      if (seen && seen.size === st.size && seen.mtime_ms === Math.floor(st.mtimeMs)) continue;
      if (st.size === 0 || st.size > MAX_FILE_BYTES) continue;
      const data = await fs.readFile(full);
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      d.prepare(
        `INSERT INTO watched_files (folder_id, rel_path, size, mtime_ms, hash, seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (folder_id, rel_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, hash = excluded.hash, seen_at = excluded.seen_at`,
      ).run(id, rel, st.size, Math.floor(st.mtimeMs), hash, now());
      // Only touched, not changed
      if (seen && seen.hash === hash) continue;
      if (opts.baselineOnly) continue;
      try {
        const stored = await saveUpload(path.basename(full), data, folder.user);
        enqueue({
          fileId: stored.id,
          identity: { key: `folder:${folder.label}:${rel}`, displayName: path.basename(full), folderLabel: folder.label, relPath: rel },
          user: folder.user,
        });
        queued++;
      } catch {
        // Unsupported or unreadable content; it stays recorded as seen until it changes
      }
    }
    d.prepare('UPDATE watched_folders SET last_scan_at = ?, last_error = NULL WHERE id = ?').run(now(), id);
  } catch (e: any) {
    d.prepare('UPDATE watched_folders SET last_scan_at = ?, last_error = ? WHERE id = ?').run(now(), String(e?.message ?? e).slice(0, 300), id);
  }
  return queued;
}

// ---------- background scanning ----------

const g = globalThis as unknown as { __folderWatcher?: { timer: NodeJS.Timeout | null; scanning: boolean } };
const state = (g.__folderWatcher ??= { timer: null, scanning: false });

export async function scanAll() {
  if (state.scanning) return;
  state.scanning = true;
  try {
    const ids = db().prepare('SELECT id FROM watched_folders WHERE enabled = 1').all() as { id: number }[];
    for (const { id } of ids) await scanFolder(id);
  } finally {
    state.scanning = false;
  }
}

export function startWatching() {
  if (state.timer) return;
  const seconds = Math.max(10, Number(process.env.WATCH_INTERVAL_SECONDS) || 60);
  state.timer = setInterval(() => void scanAll(), seconds * 1000);
  void scanAll();
}
