import path from 'node:path';
import { db } from './db';

// How a watched folder is filed. Reading every file with the assistant is slow and mostly wasted on
// folders of look-alike files (capture runs, photo sets) and raw data, so each folder inside a watched
// folder has a rule, and a file follows the rule of its nearest folder that has one:
//   file    read and file each document (the default)
//   sample  a group of look-alike files: file the first couple of each kind, keep the rest searchable
//   index   keep the documents searchable for the assistant's lookups, but do not file them
//   skip    leave the files alone: raw data, assets, things nobody needs in the wiki
// Rules come from patterns in the tree (no model), then from the assistant looking at the whole tree
// once, and people can change any of them; a person's rule is never overwritten.

export type Rule = 'file' | 'sample' | 'index' | 'skip';
export const RULES: Rule[] = ['file', 'sample', 'index', 'skip'];
export type RuleRow = { dir: string; rule: Rule; reason: string; setBy: string; setAt: string };

// how many of each kind of file a sampled folder files
const SAMPLE_SIZE = 2;
// who set a rule: the folder patterns, the assistant's plan, or a person's name
export const BY_PATTERN = 'pattern';
export const BY_PLAN = 'librarian';

const now = () => new Date().toISOString();
const dirOf = (rel: string) => (rel.includes('/') ? path.posix.dirname(rel) : '.');
const parentDir = (d: string) => (d === '.' ? null : d.includes('/') ? path.posix.dirname(d) : '.');
// a file's kind for grouping look-alikes: extension plus its name with every number replaced
export const shapeOf = (name: string) => path.posix.basename(name).toLowerCase().replace(/\d+/g, '#');
const CAMERA = /^(pxl|img|dsc|dscn|dcim|photo|image|mvimg|screenshot)[_ -]?#/;
const IMAGE = /\.(jpe?g|png|gif|webp|heic)$/i;

export function rulesFor(folderId: number): Map<string, RuleRow> {
  const rows = db().prepare('SELECT dir, rule, reason, set_by, set_at FROM folder_rules WHERE folder_id = ?').all(folderId) as any[];
  return new Map(rows.map((r) => [r.dir, { dir: r.dir, rule: r.rule, reason: r.reason ?? '', setBy: r.set_by, setAt: r.set_at }]));
}

// The rule a file follows: its nearest folder's, or file each when nothing is set
export function ruleFor(folderId: number, relPath: string, rules = rulesFor(folderId)): RuleRow & { inherited: boolean } {
  for (let d: string | null = dirOf(relPath); d !== null; d = parentDir(d)) {
    const r = rules.get(d);
    if (r) return { ...r, inherited: d !== dirOf(relPath) };
  }
  return { dir: '.', rule: 'file', reason: '', setBy: '', setAt: '', inherited: true };
}

const isPerson = (setBy: string) => setBy !== BY_PATTERN && setBy !== BY_PLAN;

// A person's choice; it wins over patterns and plans from now on
export function setRule(folderId: number, dir: string, rule: Rule | null, user: string) {
  if (rule === null) {
    db().prepare('DELETE FROM folder_rules WHERE folder_id = ? AND dir = ?').run(folderId, dir);
    return;
  }
  if (!RULES.includes(rule)) throw new Error('Unknown rule.');
  db()
    .prepare(
      `INSERT INTO folder_rules (folder_id, dir, rule, reason, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (folder_id, dir) DO UPDATE SET rule = excluded.rule, reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at`,
    )
    .run(folderId, dir, rule, `Set by ${user}`, user, now());
}

// Rules from patterns or a plan; never replaces what a person chose
function storeSuggested(folderId: number, rules: Map<string, { rule: Rule; reason: string }>, setBy: string) {
  const have = rulesFor(folderId);
  const put = db().prepare(
    `INSERT INTO folder_rules (folder_id, dir, rule, reason, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (folder_id, dir) DO UPDATE SET rule = excluded.rule, reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at`,
  );
  for (const [dir, r] of rules) {
    const old = have.get(dir);
    if (old && (isPerson(old.setBy) || (setBy === BY_PATTERN && old.setBy === BY_PLAN))) continue;
    put.run(folderId, dir, r.rule, r.reason.slice(0, 300), setBy, now());
  }
}

// ---------- the tree ----------

// files: documents the wiki can read; others: everything else (models, raw data, code), listed only
type DirInfo = { dir: string; files: string[]; others: string[]; size: number; dirs: string[] };

function treeOf(folderId: number): Map<string, DirInfo> {
  const rows = db().prepare('SELECT rel_path, size FROM watched_files WHERE folder_id = ?').all(folderId) as { rel_path: string; size: number }[];
  const otherRows = db().prepare('SELECT rel_path, size FROM folder_other_files WHERE folder_id = ?').all(folderId) as { rel_path: string; size: number }[];
  const tree = new Map<string, DirInfo>();
  const dirInfo = (d: string): DirInfo => {
    let n = tree.get(d);
    if (!n) {
      n = { dir: d, files: [], others: [], size: 0, dirs: [] };
      tree.set(d, n);
      const p = parentDir(d);
      if (p !== null) dirInfo(p).dirs.push(d);
    }
    return n;
  };
  dirInfo('.');
  for (const [list, readable] of [[rows, true], [otherRows, false]] as const) {
    for (const r of list) {
      const n = dirInfo(dirOf(r.rel_path));
      (readable ? n.files : n.others).push(path.posix.basename(r.rel_path));
      for (let d: string | null = n.dir; d !== null; d = parentDir(d)) tree.get(d)!.size += r.size;
    }
  }
  return tree;
}

// documents (or, with others, every file) at and under a folder
const allFilesUnder = (tree: Map<string, DirInfo>, d: string, others = false): number =>
  (tree.get(d)?.files.length ?? 0) +
  (others ? (tree.get(d)?.others.length ?? 0) : 0) +
  (tree.get(d)?.dirs ?? []).reduce((n, c) => n + allFilesUnder(tree, c, others), 0);

// ---------- rules from patterns, no model ----------

export function patternRules(folderId: number): Map<string, { rule: Rule; reason: string }> {
  const tree = treeOf(folderId);
  const out = new Map<string, { rule: Rule; reason: string }>();
  for (const n of tree.values()) {
    if (n.dir === '.') continue;
    // Many sub-folders holding the same kind of files: capture runs, exports, one folder per test
    if (n.dirs.length >= 5) {
      const sig = (d: string) => [...new Set([...tree.get(d)!.files, ...tree.get(d)!.others].map(shapeOf))].sort().join(',');
      // a real file name for each kind, to name the kinds in the reason
      const example = new Map<string, string>();
      for (const c of n.dirs) for (const f of [...tree.get(c)!.files, ...tree.get(c)!.others]) if (!example.has(shapeOf(f))) example.set(shapeOf(f), f);
      const counts = new Map<string, number>();
      for (const c of n.dirs) {
        const s = sig(c);
        if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
      }
      const [best, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
      if (count >= 5 && count >= n.dirs.length * 0.6) {
        const names = best.split(',').slice(0, 3).map((s) => example.get(s) ?? s);
        out.set(n.dir, { rule: 'sample', reason: `${count} sub-folders hold the same kind of files, such as ${names.join(', ')}` });
        continue;
      }
    }
    // A run of camera photos or a numbered series in one folder
    const shapes = new Map<string, number>();
    for (const f of n.files) shapes.set(shapeOf(f), (shapes.get(shapeOf(f)) ?? 0) + 1);
    const camera = n.files.filter((f) => IMAGE.test(f) && CAMERA.test(shapeOf(f))).length;
    const [seriesShape, seriesCount] = [...shapes.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    const series = n.files.find((f) => shapeOf(f) === seriesShape) ?? seriesShape;
    if (camera >= 8 && camera >= n.files.length * 0.7) out.set(n.dir, { rule: 'sample', reason: `${camera} camera photos` });
    else if (seriesCount >= 10 && seriesCount >= n.files.length * 0.7) out.set(n.dir, { rule: 'sample', reason: `${seriesCount} numbered files like ${series}` });
  }
  return out;
}

export function applyPatternRules(folderId: number) {
  storeSuggested(folderId, patternRules(folderId), BY_PATTERN);
}

// ---------- the assistant's plan ----------

// The tree as text for the assistant: each folder with its file count, kinds, a few names and the
// rule patterns suggest. Folders under a look-alike group are folded into one line.
export function planOutline(folderId: number, maxLines = 160): string {
  const tree = treeOf(folderId);
  const root = db().prepare('SELECT path FROM watched_folders WHERE id = ?').get(folderId) as { path: string } | undefined;
  const patterns = patternRules(folderId);
  const lines: string[] = [];
  const walk = (d: string, depth: number) => {
    if (lines.length >= maxLines) return;
    const n = tree.get(d)!;
    const exts = new Map<string, number>();
    for (const f of [...n.files, ...n.others]) {
      const e = path.posix.extname(f).slice(1).toLowerCase() || 'none';
      exts.set(e, (exts.get(e) ?? 0) + 1);
    }
    const kinds = [...exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([e, c]) => `${c} ${e}`).join(', ');
    const examples = [...new Set([...n.files, ...n.others])].slice(0, 3).join(', ');
    const docs = allFilesUnder(tree, d);
    const total = allFilesUnder(tree, d, true);
    const hint = patterns.get(d);
    const name = d === '.' ? `(top level${root ? `: "${path.basename(root.path)}"` : ''})` : `${d}/`;
    lines.push(
      `${'  '.repeat(depth)}${name} | ${total} files in all, ${docs} of them documents the wiki can read, ${(n.size / 1e6).toFixed(1)} MB` +
        (n.files.length + n.others.length ? `; here: ${kinds}; e.g. ${examples}` : '') +
        (n.dirs.length ? `; ${n.dirs.length} sub-folders` : '') +
        (hint ? ` | looks like: ${hint.reason}` : ''),
    );
    // a look-alike group is described by its first sub-folder only
    const kids = hint && n.dirs.length >= 5 ? n.dirs.sort().slice(0, 1) : n.dirs.sort();
    for (const c of kids) walk(c, depth + 1);
    if (kids.length < n.dirs.length) lines.push(`${'  '.repeat(depth + 1)}...and ${n.dirs.length - kids.length} more sub-folders like it`);
  };
  walk('.', 0);
  if (lines.length >= maxLines) lines.push('...(more folders not shown)');
  return lines.join('\n');
}

export const PLAN_SYSTEM = `You plan how a company wiki files the documents in a watched folder. Reading every file with the assistant is slow, so you decide per folder how its files are handled.

Rules:
- file: documents worth turning into wiki pages: procedures, guides, notes, specifications, reports, manuals.
- sample: many look-alike files or sub-folders, such as test runs, capture sessions or photo sets. The first couple of each kind are filed so the wiki learns what they are; the rest are kept searchable only.
- index: reference material people may want to look things up in, but that should not become pages: large exports, copies of external documents, generated listings.
- skip: nothing anyone needs: raw sensor or measurement data, logs, assets such as fonts, logos and icons, build output, folders marked to ignore.

A folder's rule applies to everything under it unless a sub-folder has its own. The top level is "file" unless you say otherwise.
Answer with one line per folder you give a rule, nothing else, in this form:
folder path | rule | short reason
Use the folder paths exactly as listed, and (top level) for the top level.
Folders with no documents the wiki can read need no rule, but their contents tell you what a neighbouring folder holds.`;

export function parsePlan(text: string, folderId: number): Map<string, { rule: Rule; reason: string }> {
  const tree = treeOf(folderId);
  const out = new Map<string, { rule: Rule; reason: string }>();
  for (const line of text.split('\n')) {
    const m = line.match(/^[\s*>`-]*(.+?)\s*\|\s*(file|sample|index|skip)\s*(?:\|\s*(.*?))?\s*$/i);
    if (!m) continue;
    let dir = m[1].trim().replace(/^["'`]|["'`]$/g, '').replace(/\/+$/, '');
    if (/^\(?top[ -]?level\)?$|^\.$|^\/$/i.test(dir)) dir = '.';
    if (!tree.has(dir)) continue;
    out.set(dir, { rule: m[2].toLowerCase() as Rule, reason: (m[3] ?? '').trim() || 'From the plan' });
  }
  return out;
}

export function storePlan(folderId: number, plan: Map<string, { rule: Rule; reason: string }>) {
  storeSuggested(folderId, plan, BY_PLAN);
}

export function hasPlan(folderId: number): boolean {
  return !!db().prepare('SELECT 1 FROM folder_rules WHERE folder_id = ? AND set_by = ? LIMIT 1').get(folderId, BY_PLAN);
}

// ---------- applying a rule ----------

// In a sampled folder, whether this file is one of the first few of its kind (by path order)
export function inSample(folderId: number, ruleDir: string, relPath: string): boolean {
  const prefix = ruleDir === '.' ? '' : `${ruleDir}/`;
  const shape = shapeOf(relPath);
  const same = (db().prepare('SELECT rel_path FROM watched_files WHERE folder_id = ? AND rel_path LIKE ? ESCAPE ?').all(folderId, `${prefix.replace(/[%_\\]/g, '\\$&')}%`, '\\') as { rel_path: string }[])
    .map((r) => r.rel_path)
    .filter((p) => shapeOf(p) === shape)
    .sort();
  return same.indexOf(relPath) < SAMPLE_SIZE;
}

// What the queue does with a file from a watched folder
export function decide(folderLabel: string, relPath: string): { action: 'file' | 'index' | 'skip'; why: string } {
  const folder = db().prepare('SELECT id FROM watched_folders WHERE label = ?').get(folderLabel) as { id: number } | undefined;
  if (!folder) return { action: 'file', why: '' };
  const r = ruleFor(folder.id, relPath);
  const where = r.dir === '.' ? 'the top of the folder' : `"${r.dir}"`;
  const because = r.reason ? ` (${r.reason})` : '';
  switch (r.rule) {
    case 'skip':
      return { action: 'skip', why: `Not read: ${where} is set to skip${because}.` };
    case 'index':
      return { action: 'index', why: `Kept searchable, not filed: ${where} is set to keep searchable only${because}.` };
    case 'sample':
      return inSample(folder.id, r.dir, relPath)
        ? { action: 'file', why: '' }
        : { action: 'index', why: `Kept searchable, not filed: ${where} is filed by sample and this is not one of the first ${SAMPLE_SIZE} of its kind${because}.` };
    default:
      return { action: 'file', why: '' };
  }
}

// Text that is mostly numbers and punctuation: sensor readings, exports, logs of values
export function looksLikeData(text: string): boolean {
  if (text.length < 3000) return false;
  const sample = text.slice(0, 20000).replace(/\s+/g, '');
  const letters = (sample.match(/\p{L}/gu) ?? []).length;
  return letters / Math.max(1, sample.length) < 0.35;
}

// ---------- the tree with rules and filing counts, for Settings ----------

export type PlanNode = {
  dir: string;
  name: string;
  files: number; // all files under it, readable or not
  documents: number; // the files under it the wiki can read
  rule: RuleRow | null; // set on this folder itself
  effective: Rule; // what applies here, set here or inherited
  // what happened to the files under it, by filing outcome; files never queued count as skipped
  // when a skip rule covers them, and as unfiled otherwise (seen when the folder was added)
  counts: Record<string, number>;
  children: PlanNode[];
};

export function planTree(folderId: number, folderLabel: string): PlanNode {
  const tree = treeOf(folderId);
  const root = db().prepare('SELECT path FROM watched_folders WHERE id = ?').get(folderId) as { path: string } | undefined;
  const rules = rulesFor(folderId);
  const jobs = db()
    .prepare(
      `SELECT rel_path, status FROM ingest_jobs j WHERE folder_label = ? AND mode != 'tidy'
       AND id = (SELECT MAX(id) FROM ingest_jobs k WHERE k.doc_key = j.doc_key)`,
    )
    .all(folderLabel) as { rel_path: string | null; status: string }[];
  const statusOf = new Map(jobs.filter((j) => j.rel_path).map((j) => [j.rel_path!, j.status]));
  const files = db().prepare('SELECT rel_path FROM watched_files WHERE folder_id = ?').all(folderId) as { rel_path: string }[];
  const counts = new Map<string, Record<string, number>>();
  const others = db().prepare('SELECT rel_path FROM folder_other_files WHERE folder_id = ?').all(folderId) as { rel_path: string }[];
  for (const { rel_path, other } of [...files, ...others.map((o) => ({ ...o, other: true }))] as { rel_path: string; other?: boolean }[]) {
    const status = other ? 'other' : statusOf.get(rel_path) ?? (ruleFor(folderId, rel_path, rules).rule === 'skip' ? 'skipped' : 'unfiled');
    for (let d: string | null = dirOf(rel_path); d !== null; d = parentDir(d)) {
      const c = counts.get(d) ?? {};
      c[status] = (c[status] ?? 0) + 1;
      counts.set(d, c);
    }
  }
  const build = (d: string, inherited: Rule): PlanNode => {
    const own = rules.get(d) ?? null;
    const effective = own?.rule ?? inherited;
    return {
      dir: d,
      name: d === '.' ? (root ? path.basename(root.path) : folderLabel) : path.posix.basename(d),
      files: allFilesUnder(tree, d, true),
      documents: allFilesUnder(tree, d),
      rule: own,
      effective,
      counts: counts.get(d) ?? {},
      children: (tree.get(d)?.dirs ?? []).sort((a, b) => a.localeCompare(b)).map((c) => build(c, effective)),
    };
  };
  return build('.', 'file');
}
