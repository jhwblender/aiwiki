import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from './db';
import { MAX_FILE_BYTES, saveUpload } from './files';
import { enqueue, enqueuePlan } from './queue';
import { applyPatternRules, decide, hasPlan } from './filingPlan';
import { refileFiles } from './refile';

// Folders on the server's disk that feed the wiki. Every scan walks each enabled folder, and a
// file that is new or whose content changed goes to the ingest queue as a version of a document
// identified by the folder label and its path inside the folder. Nothing is ever written to the folder.

export type WatchedFolder = {
  id: number;
  label: string;
  path: string;
  user: string;
  // wiki: files are filed into the wiki; personal: only searchable by the user's chat
  visibility: 'wiki' | 'personal';
  enabled: boolean;
  lastScanAt: string | null;
  lastError: string | null;
  fileCount: number;
  insideOf: string | null; // label of a watched folder that contains this one
  contains: string[]; // labels of watched folders inside this one, whose files they own
};

const SUPPORTED = new Set(['.pdf', '.docx', '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
// Folders that never hold anyone's documents: package and build caches, program internals
const SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information', '__pycache__', 'site-packages', '.venv', 'venv']);
const SKIP_DIR_SUFFIX = /\.(app|framework|bundle|egg-info|dist-info)$/i;
// System files Windows and macOS leave in every folder
const SKIP_FILES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);
const MAX_DEPTH = 20;
const MAX_FILES = 5000;
// files the wiki cannot read are listed (not read) up to this many, so the tree shows them
const MAX_OTHER_FILES = 100_000;
// A file changed this recently may still be copying or syncing; wait for the next scan
const SETTLE_MS = 10_000;

const now = () => new Date().toISOString();

function rowToFolder(r: any): WatchedFolder {
  return {
    id: r.id,
    label: r.label,
    path: r.path,
    user: r.user,
    visibility: r.visibility === 'personal' ? 'personal' : 'wiki',
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

// Point a folder at its new location after it was renamed or moved. The folder takes the top
// level folder's name as its label (with a suffix when another folder already uses it), and
// everything recorded under the old name moves over with it — documents, waiting jobs, plan
// runs — so nothing already filed is filed again and nothing keeps showing the old folder.
// Returns the label it now goes by.
export async function changeFolderPath(id: number, newPath: string): Promise<{ label: string }> {
  const dir = path.resolve(fromWindowsPath(newPath.trim()));
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    throw new Error(`The wiki server cannot find the folder ${dir}.`);
  }
  if (!stat.isDirectory()) throw new Error(`${dir} is a file, not a folder.`);
  const d = db();
  const folder = d.prepare('SELECT * FROM watched_folders WHERE id = ?').get(id) as { label: string; path: string } | undefined;
  if (!folder) throw new Error('Folder not found.');
  const same = d.prepare('SELECT label FROM watched_folders WHERE path = ? AND id != ?').get(dir, id) as { label: string } | undefined;
  if (same) throw new Error(`That folder is already watched as "${same.label}".`);
  // A job being worked on files under the identity it was queued with; renaming the folder under
  // it would leave one document behind the others, so the change waits.
  if (d.prepare("SELECT 1 FROM ingest_jobs WHERE folder_label = ? AND status = 'working' AND mode != 'tidy' LIMIT 1").get(folder.label)) {
    throw new Error(`The wiki is still filing from "${folder.label}". Wait for that to finish (or cancel it), then change the folder.`);
  }
  const sameDir = dir === folder.path;
  // The top level folder's own name is the label, so the label follows the move.
  let label = folder.label;
  if (!sameDir) {
    const base = path.basename(dir);
    if (base) {
      label = base;
      for (let n = 2; d.prepare('SELECT 1 FROM watched_folders WHERE label = ? AND id != ?').get(label, id); n++) label = `${base} ${n}`;
    }
  }
  d.transaction(() => {
    d.prepare('UPDATE watched_folders SET path = ?, label = ?, last_error = NULL WHERE id = ?').run(dir, label, id);
    if (label !== folder.label) {
      // Documents and jobs are identified by "folder:<label>:<path inside>" (the same for
      // personal ones), so the recorded identity moves to the new name with the folder.
      for (const kind of ['folder', 'personal'] as const) {
        const from = `${kind}:${folder.label}:`;
        const to = `${kind}:${label}:`;
        const like = `${likeEscape(from)}%`;
        const move = (table: 'documents' | 'ingest_jobs') =>
          d.prepare(`UPDATE ${table} SET doc_key = ? || substr(doc_key, ?) WHERE doc_key LIKE ? ESCAPE '\\'`).run(to, from.length + 1, like);
        move('documents');
        move('ingest_jobs');
      }
      // A plan run keys on the label whole, and every job shows where its file came from.
      d.prepare('UPDATE ingest_jobs SET folder_label = ? WHERE folder_label = ?').run(label, folder.label);
      d.prepare('UPDATE documents SET folder_label = ? WHERE folder_label = ?').run(label, folder.label);
      d.prepare('UPDATE ingest_jobs SET doc_key = ? WHERE doc_key = ?').run(`plan:${label}`, `plan:${folder.label}`);
    }
  })();
  return { label };
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// A Windows path pasted in while the wiki runs in WSL: C:\Users\me\Docs -> /mnt/c/Users/me/Docs
function fromWindowsPath(p: string): string {
  const m = p.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (!m || process.platform === 'win32') return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

export async function addFolder(input: {
  label: string;
  path: string;
  user: string;
  fileExisting: boolean;
  visibility?: 'wiki' | 'personal';
}): Promise<WatchedFolder> {
  if (input.visibility === 'personal' && (!input.user || input.user === 'anonymous')) {
    throw new Error('A personal folder belongs to someone. Set your name on this page first.');
  }
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
    .prepare('INSERT INTO watched_folders (label, path, user, enabled, created_at, visibility) VALUES (?, ?, ?, 1, ?, ?)')
    .run(label, dir, input.user, now(), input.visibility === 'personal' ? 'personal' : 'wiki');
  const id = Number(r.lastInsertRowid);
  // Without filing what is already there, the first scan only records the files as seen. With it,
  // the tree is recorded first so a plan decides how the files are handled before any is read.
  await scanFolder(id, { baselineOnly: true });
  if (input.visibility !== 'personal') enqueuePlan({ id, label, user: input.user });
  if (input.fileExisting) await refileFiles(id, ['.']);
  return rowToFolder({ ...(db().prepare('SELECT * FROM watched_folders WHERE id = ?').get(id) as any), file_count: countFiles(id) });
}

function countFiles(id: number) {
  return (db().prepare('SELECT COUNT(*) AS n FROM watched_files WHERE folder_id = ?').get(id) as { n: number }).n;
}

// Personal and wiki copies of a file are separate documents, so making a folder feed the wiki
// files its documents fresh instead of treating them as already handled
function identityFor(folder: { label: string; user: string; visibility: string }, rel: string) {
  const personal = folder.visibility === 'personal';
  return {
    key: `${personal ? 'personal' : 'folder'}:${folder.label}:${rel}`,
    displayName: path.basename(rel),
    folderLabel: folder.label,
    relPath: rel,
    personal,
    owner: personal ? folder.user : null,
  };
}

// Switch a folder between feeding the wiki and personal only.
// To personal: its documents become searchable by the owner only (what is already in the wiki stays).
// To wiki: its documents become searchable by everyone, and with fileExisting they are filed now.
export async function setVisibility(id: number, visibility: 'wiki' | 'personal', fileExisting = false): Promise<number> {
  const d = db();
  const folder = d.prepare('SELECT * FROM watched_folders WHERE id = ?').get(id) as any;
  if (!folder) throw new Error('Folder not found.');
  if (visibility === 'personal' && (!folder.user || folder.user === 'anonymous')) {
    throw new Error('A personal folder belongs to someone, but this folder was added without a name. Add it again after setting your name.');
  }
  d.prepare('UPDATE watched_folders SET visibility = ? WHERE id = ?').run(visibility, id);
  const like = (prefix: string) => `${prefix}:${folder.label}:%`;
  if (visibility === 'personal') {
    d.prepare('UPDATE documents SET personal = 1, owner = ? WHERE doc_key LIKE ? OR doc_key LIKE ?').run(folder.user, like('folder'), like('personal'));
    return 0;
  }
  d.prepare('UPDATE documents SET personal = 0, owner = NULL WHERE doc_key LIKE ?').run(like('folder'));
  // The private copies are no longer needed for searching
  d.prepare('DELETE FROM documents_fts WHERE document_id IN (SELECT id FROM documents WHERE doc_key LIKE ?)').run(like('personal'));
  if (!hasPlan(id)) enqueuePlan(folder);
  return fileExisting ? refileFiles(id, ['.']) : 0;
}

// File again what sits under one folder after its rule changed: files that were skipped or kept
// searchable, or never queued, go back in the queue (filed ones and waiting ones are left alone)
export async function refile(id: number, dir: string): Promise<number> {
  const folder = db().prepare('SELECT id FROM watched_folders WHERE id = ?').get(id);
  if (!folder) throw new Error('Folder not found.');
  return refileFiles(id, [dir]);
}

// Queue every recorded file of a folder for filing, except those its rules skip

export function setEnabled(id: number, enabled: boolean) {
  db().prepare('UPDATE watched_folders SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

export function removeFolder(id: number) {
  const d = db();
  d.prepare('DELETE FROM watched_files WHERE folder_id = ?').run(id);
  d.prepare('DELETE FROM folder_rules WHERE folder_id = ?').run(id);
  d.prepare('DELETE FROM folder_other_files WHERE folder_id = ?').run(id);
  d.prepare('DELETE FROM watched_folders WHERE id = ?').run(id);
}

// Keep the list of unreadable files in step with the folder: new ones get their size once, gone ones go
async function recordOthers(id: number, root: string, fullPaths: string[]) {
  const d = db();
  const known = new Set((d.prepare('SELECT rel_path FROM folder_other_files WHERE folder_id = ?').all(id) as { rel_path: string }[]).map((r) => r.rel_path));
  const now = new Set<string>();
  const added: [string, number][] = [];
  for (const full of fullPaths) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    now.add(rel);
    if (known.has(rel)) continue;
    let size = 0;
    try {
      size = (await fs.stat(full)).size;
    } catch {}
    added.push([rel, size]);
  }
  d.transaction(() => {
    const put = d.prepare('INSERT OR REPLACE INTO folder_other_files (folder_id, rel_path, size) VALUES (?, ?, ?)');
    for (const [rel, size] of added) put.run(id, rel, size);
    const drop = d.prepare('DELETE FROM folder_other_files WHERE folder_id = ? AND rel_path = ?');
    for (const rel of known) if (!now.has(rel)) drop.run(id, rel);
  })();
}

// skip: other watched folders inside this one; their files belong to them. others collects the files
// the wiki cannot read, so the tree can show them.
async function walk(root: string, skip: Set<string>, others: string[] = []): Promise<string[]> {
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
        if (!SKIP_DIRS.has(e.name.toLowerCase()) && !SKIP_DIR_SUFFIX.test(e.name)) await visit(full, depth + 1);
      } else if (e.isFile() && SKIP_FILES.has(e.name.toLowerCase())) {
        continue;
      } else if (e.isFile() && SUPPORTED.has(path.extname(e.name).toLowerCase())) {
        out.push(full);
        if (out.length >= MAX_FILES) return;
      } else if (e.isFile() && others.length < MAX_OTHER_FILES) {
        others.push(full);
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
    const others: string[] = [];
    const files = await walk(folder.path, nestedInside(folder.path, id), others);
    await recordOthers(id, folder.path, others);
    const rels = files.map((full) => path.relative(folder.path, full).split(path.sep).join('/'));
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
      // A file its folder's rule skips is recorded as seen but not copied or queued
      if (folder.visibility !== 'personal' && decide(folder.label, rel).action === 'skip') continue;
      try {
        const stored = await saveUpload(path.basename(full), data, folder.user);
        enqueue({ fileId: stored.id, identity: identityFor(folder, rel), user: folder.user, mode: folder.visibility === 'personal' ? 'index' : 'file' });
        queued++;
      } catch {
        // Unsupported or unreadable content; it stays recorded as seen until it changes
      }
    }
    // New sub-folders may form new look-alike groups
    let ruleChanges: string[] = [];
    if (queued && folder.visibility !== 'personal') ruleChanges = applyPatternRules(id);
    // The full listing succeeded: forget files that are gone, so the folder's plan and counts
    // show the folder as it is now (e.g. after a move), not as it was where it used to live.
    d.prepare('DELETE FROM watched_files WHERE folder_id = ? AND rel_path NOT IN (SELECT value FROM json_each(?))').run(id, JSON.stringify(rels));
    d.prepare('UPDATE watched_folders SET last_scan_at = ?, last_error = NULL WHERE id = ?').run(now(), id);
    // A new pattern rule changed how files are handled: skipped ones under it are reconsidered
    if (ruleChanges.length) void refileFiles(id, ruleChanges);
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
  // Folders watched before filing plans existed get one now
  for (const f of db().prepare("SELECT id, label, user FROM watched_folders WHERE visibility = 'wiki'").all() as { id: number; label: string; user: string }[]) {
    if (!hasPlan(f.id) && !db().prepare("SELECT 1 FROM ingest_jobs WHERE doc_key = ?").get(`plan:${f.label}`)) enqueuePlan(f);
  }
  const seconds = Math.max(10, Number(process.env.WATCH_INTERVAL_SECONDS) || 60);
  state.timer = setInterval(() => void scanAll(), seconds * 1000);
  void scanAll();
}
