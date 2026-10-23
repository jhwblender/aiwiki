import { db } from './db';
import { listPages, normalizePath, readPage } from './wiki';
import { pendingCounts } from './proposals';

// The librarian keeps the wiki organised beyond single edits. Before the assistant looks at a
// section, this survey works out what is worth its attention without a model: pages that share
// much of their wording, pages that read like another section, folders of pages with no overview,
// links to pages that do not exist, and which watched folders the pages were filed from. The
// assistant then reads the pages it needs and suggests moves, merges and overview pages through
// the normal suggestion tools. Everything it finds is a hint; nothing here changes the wiki.

// Most pages one tidy run may suggest changes to, unless changed on Settings; each page counts once
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 50;
// The scope of a run over the whole wiki: its sections, the home page and the watched folders
export const WHOLE = '*';
// Who starts the runs the librarian schedules for itself
export const AUTO_USER = 'Librarian';

export const scopeName = (section: string) => (section === WHOLE ? 'the whole wiki' : `the ${section} section`);

function setting(key: string): string | undefined {
  return (db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

// The limit per run, and whether the librarian tidies on its own after the wiki changes (on unless turned off)
export function librarianSettings(): { limit: number; auto: boolean } {
  const limit = Number(setting('librarian.limit'));
  return { limit: Number.isInteger(limit) && limit >= 1 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT, auto: setting('librarian.auto') !== '0' };
}

export function saveLibrarianSettings(input: { limit?: number; auto?: boolean }) {
  const put = db().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  if (input.limit !== undefined) {
    const n = Math.floor(Number(input.limit));
    if (!(n >= 1 && n <= MAX_LIMIT)) throw new Error(`The limit must be a number from 1 to ${MAX_LIMIT}.`);
    put.run('librarian.limit', String(n));
  }
  if (input.auto !== undefined) put.run('librarian.auto', input.auto ? '1' : '0');
  return librarianSettings();
}

type Page = { path: string; title: string; content: string; words: Set<string>; shingles: Set<string> };

const STOP = new Set(
  ('also been being both could does each from have here into just like made make many more most much must only ' +
    'other over same should some such than that their them then there these they this those through very what when ' +
    'where which while will with would your about after before under until upon page pages wiki').split(' '),
);

function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_w, t: string, label?: string) => label ?? t)
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/[#*_>`|[\]-]+/g, ' ')
    .toLowerCase();
}

function wordsOf(md: string): string[] {
  return plain(md).match(/[\p{L}\p{N}]{4,}/gu)?.filter((w) => !STOP.has(w)) ?? [];
}

// Three-word runs, so copied passages stand out from pages that only share a topic
function shinglesOf(words: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

function shared(a: Set<string>, b: Set<string>): number {
  let n = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) n++;
  return n;
}

const jaccard = (a: Set<string>, b: Set<string>) => {
  const n = shared(a, b);
  return n ? n / (a.size + b.size - n) : 0;
};
// Share of the smaller page that also appears in the other
const overlap = (a: Set<string>, b: Set<string>) => (Math.min(a.size, b.size) ? shared(a, b) / Math.min(a.size, b.size) : 0);

const top = (p: string) => p.split('/')[0];
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null);
const inSection = (p: string, section: string) => p === section || p.startsWith(section + '/');
const related = (a: string, b: string) => a.startsWith(b + '/') || b.startsWith(a + '/');
const pct = (x: number) => `${Math.round(x * 100)}%`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 3) + '...' : s);

async function loadPages(): Promise<Page[]> {
  const out: Page[] = [];
  for (const { path, title } of await listPages()) {
    const content = (await readPage(path)) ?? '';
    const words = wordsOf(content);
    out.push({ path, title, content, words: new Set(words), shingles: shinglesOf(words) });
  }
  return out;
}

// How close a page is to a group, by vocabulary with the closest few pages of the group, so one
// big section does not drown out a small one
function closeness(p: Page, group: Page[]): number {
  const scores = group.filter((q) => q.path !== p.path && !related(p.path, q.path)).map((q) => jaccard(p.words, q.words));
  if (!scores.length) return 0;
  const best = scores.sort((x, y) => y - x).slice(0, 3);
  return best.reduce((s, x) => s + x, 0) / best.length;
}

// Pairs of pages that repeat each other, best matches first; skip leaves out pairs not of interest
function duplicatePairs(from: Page[], all: Page[], skip: (a: Page, b: Page) => boolean) {
  const out: { a: Page; b: Page; why: string; score: number }[] = [];
  for (const a of from) {
    for (const b of all) {
      if (a.path === b.path || related(a.path, b.path) || skip(a, b)) continue;
      const sameTitle = a.title.toLowerCase() === b.title.toLowerCase();
      const copied = a.shingles.size >= 8 && b.shingles.size >= 8 ? overlap(a.shingles, b.shingles) : 0;
      const topic = a.words.size >= 12 && b.words.size >= 12 ? jaccard(a.words, b.words) : 0;
      const reasons: string[] = [];
      if (sameTitle) reasons.push('same title');
      if (copied >= 0.3) reasons.push(`${pct(copied)} of the shorter page's wording also appears in the other`);
      else if (topic >= 0.4) reasons.push(`${pct(topic)} of their vocabulary is shared`);
      if (reasons.length) out.push({ a, b, why: reasons.join('; '), score: copied + topic + (sameTitle ? 0.5 : 0) });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

function bySectionOf(all: Page[]): Map<string, Page[]> {
  const out = new Map<string, Page[]>();
  for (const p of all) {
    if (p.path === 'index') continue;
    if (!out.has(top(p.path))) out.set(top(p.path), []);
    out.get(top(p.path))!.push(p);
  }
  return out;
}

// The first sentence of a page's prose (lists and tables only when there is nothing else), to say
// in a line what it is about
function gist(md: string, n = 120): string {
  const blocks = md
    .replace(/^#{1,6}\s.*$/gm, '')
    .split(/\n\s*\n/)
    .filter((b) => b.trim());
  const prose = blocks.find((b) => !/^\s*([-*+|>]|\d+[.)])\s?/.test(b.trim()));
  if (prose) return firstSentence(prose, n);
  // only lists: name what the page is divided into
  const headings = [...md.matchAll(/^#{2,6}\s+(.+)$/gm)].map((m) => m[1].trim());
  return headings.length ? clip(`covers ${headings.join(', ')}`, n) : firstSentence(blocks[0] ?? '', n);
}

function firstSentence(md: string, n: number): string {
  const text = md.replace(/^#{1,6}\s.*$/gm, '').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_w, t: string, l?: string) => l ?? t).replace(/\s+/g, ' ').trim();
  return clip(text.split(/(?<=[.!?])\s/)[0] ?? '', n);
}

// Text of a page without its title and headings, to tell an empty overview from a real one
const bodyChars = (md: string) => md.replace(/^#{1,6}\s.*$/gm, '').replace(/\s+/g, ' ').trim().length;

// Top-level sections with how many pages sit in each, for the Tidy buttons on Settings
export async function listSections(): Promise<{ section: string; title: string; pages: number }[]> {
  const pages = await listPages();
  const titles = new Map(pages.map((p) => [p.path, p.title]));
  const counts = new Map<string, number>();
  for (const p of pages) {
    if (p.path === 'index') continue;
    counts.set(top(p.path), (counts.get(top(p.path)) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([section, n]) => ({ section, title: titles.get(section) ?? section.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), pages: n }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

function linksIn(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) out.push(m[1]);
  for (const m of md.matchAll(/\]\(\/wiki\/([^)\s#]+)/g)) out.push(decodeURIComponent(m[1]));
  return out;
}

function safePath(target: string): string | null {
  try {
    return normalizePath(target);
  } catch {
    return null;
  }
}

// Where each page's approved content came from in the watched folders: folder label and the
// folder inside it (never a server path)
function folderOrigins(): Map<string, Set<string>> {
  const rows = db()
    .prepare(
      `SELECT ps.page_path AS page, s.folder_label AS label, s.rel_path AS rel FROM page_sources ps
       JOIN sources s ON s.id = ps.source_id WHERE s.kind = 'file' AND s.folder_label IS NOT NULL`,
    )
    .all() as { page: string; label: string; rel: string | null }[];
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const dir = r.rel && r.rel.includes('/') ? r.rel.slice(0, r.rel.lastIndexOf('/')) : '';
    const where = dir ? `${r.label}: ${dir}/` : `${r.label} (top level)`;
    if (!out.has(r.page)) out.set(r.page, new Set());
    out.get(r.page)!.add(where);
  }
  return out;
}

function pendingOpsIn(section: string): { kind: string; path: string; newPath: string | null; summary: string }[] {
  const rows = db()
    .prepare(
      `SELECT o.kind, o.page_path AS path, o.new_path AS newPath, cs.summary FROM page_ops o
       JOIN change_sets cs ON cs.id = o.change_set_id WHERE o.status = 'pending' ORDER BY o.id`,
    )
    .all() as { kind: string; path: string; newPath: string | null; summary: string }[];
  return section ? rows.filter((r) => inSection(r.path, section) || (r.newPath && inSection(r.newPath, section))) : rows;
}

const FOLDER_MAP_HEADER =
  'How the team groups its own documents: the watched folders as trees with file counts, and where in the wiki the pages filed from each folder ended up (-> section (pages)). ' +
  'Use it to see what belongs together; organise the wiki by topic for a reader rather than copying the folder layout:';

// The watched folders that feed the wiki, as compact trees with file counts, and where in the
// wiki the pages filed from each folder now live. Built from what the watcher and the approvals
// recorded; nothing is read from disk, and only folder labels and relative paths appear.
function folderMap(known: Set<string>, onlyLabels?: Set<string>, maxDirs = 40): string[] {
  const folders = (db().prepare("SELECT id, label FROM watched_folders WHERE visibility = 'wiki' ORDER BY label").all() as { id: number; label: string }[]).filter(
    (f) => !onlyLabels || onlyLabels.has(f.label),
  );
  if (!folders.length) return [];
  // folder label -> folder path -> wiki place -> pages; a page counts for its folder and every folder above it
  const placed = new Map<string, Map<string, Map<string, number>>>();
  const rows = db()
    .prepare(
      `SELECT DISTINCT ps.page_path AS page, s.folder_label AS label, s.rel_path AS rel FROM page_sources ps
       JOIN sources s ON s.id = ps.source_id WHERE s.kind = 'file' AND s.folder_label IS NOT NULL`,
    )
    .all() as { page: string; label: string; rel: string | null }[];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!known.has(r.page)) continue;
    const place = r.page.split('/').slice(0, 2).join('/');
    const parts = (r.rel ?? '').split('/').slice(0, -1);
    for (let i = 0; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/') || '.';
      const key = `${r.label}\n${dir}\n${r.page}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!placed.has(r.label)) placed.set(r.label, new Map());
      const byDir = placed.get(r.label)!;
      if (!byDir.has(dir)) byDir.set(dir, new Map());
      byDir.get(dir)!.set(place, (byDir.get(dir)!.get(place) ?? 0) + 1);
    }
  }
  const where = (label: string, dir: string) => {
    const m = placed.get(label)?.get(dir);
    if (!m) return '';
    const tops = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return ` -> ${tops.map(([p, n]) => `${p} (${n})`).join(', ')}${m.size > 3 ? ', ...' : ''}`;
  };
  const lines: string[] = [];
  for (const f of folders) {
    const files = (db().prepare('SELECT rel_path FROM watched_files WHERE folder_id = ?').all(f.id) as { rel_path: string }[]).map((r) => r.rel_path);
    const total = new Map<string, number>();
    for (const file of files) {
      const parts = file.split('/').slice(0, -1);
      for (let i = 1; i <= Math.min(parts.length, 3); i++) {
        const d = parts.slice(0, i).join('/');
        total.set(d, (total.get(d) ?? 0) + 1);
      }
    }
    lines.push(`- "${f.label}" (${files.length} files)${where(f.label, '.')}`);
    // the shallowest folders first when the tree is large, shown in tree order
    const dirs = [...total.keys()]
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
      .slice(0, maxDirs)
      .sort();
    for (const d of dirs) {
      const n = total.get(d)!;
      lines.push(`${'  '.repeat(d.split('/').length)}- ${d.split('/').pop()}/ (${n} file${n === 1 ? '' : 's'})${where(f.label, d)}`);
    }
    if (total.size > dirs.length) lines.push(`  ...and ${total.size - dirs.length} more folders`);
  }
  return lines;
}

export type Survey = { section: string; pages: number; findings: number; report: string };

// A plain-text report on one section (or the whole wiki) for the assistant, kept short enough for a local model
export async function surveySection(sectionInput: string): Promise<Survey> {
  if (isWhole(sectionInput)) return surveyWiki();
  const section = normalizePath(sectionInput);
  const all = await loadPages();
  const known = new Set(all.map((p) => p.path));
  const pending = pendingCounts();
  const suggestedNew = new Set([...pending.entries()].filter(([, v]) => v.isNew).map(([p]) => p));
  const mine = all.filter((p) => inSection(p.path, section));
  const lines: string[] = [];
  let findings = 0;

  if (!mine.length) {
    return { section, pages: 0, findings: 0, report: `There are no pages in "${section}".` };
  }

  // The tree, with sizes, so the assistant sees the shape before reading anything
  lines.push(`Section "${section}": ${mine.length} page${mine.length > 1 ? 's' : ''}.`, '', 'Pages:');
  const TREE_MAX = 60;
  const shallowest = Math.min(...mine.map((p) => p.path.split('/').length));
  for (const p of mine.slice(0, TREE_MAX)) {
    const depth = p.path.split('/').length - shallowest;
    const n = pending.get(p.path)?.count ?? 0;
    lines.push(`${'  '.repeat(depth)}- ${p.path} "${p.title}" (${p.content.length} chars${n ? `, ${n} pending suggestion${n > 1 ? 's' : ''}` : ''})`);
  }
  if (mine.length > TREE_MAX) lines.push(`  ...and ${mine.length - TREE_MAX} more`);

  // Pages that repeat each other, inside the section or with a page elsewhere; each pair once
  const dupes = duplicatePairs(mine, all, (a, b) => inSection(b.path, section) && b.path < a.path);
  if (dupes.length) {
    lines.push('', 'Possible duplicates or overlapping pages (read both before deciding; a merge keeps one page and removes the other):');
    for (const d of dupes.slice(0, 8)) lines.push(`- ${d.a.path} and ${d.b.path}: ${d.why}`);
    findings += Math.min(dupes.length, 8);
  }

  // Pages that read more like another section than their own
  const bySection = bySectionOf(all);
  const misplaced: string[] = [];
  const homeOf = (p: Page) => (inSection(p.path, section) ? section : top(p.path));
  const groupFor = (name: string) => (name === section ? mine : bySection.get(name) ?? []);
  const candidates = [
    ...mine.filter((p) => p.path !== section),
    // pages elsewhere that look like they belong here
    ...all.filter((p) => !inSection(p.path, section) && p.path !== 'index' && !section.startsWith(p.path + '/')),
  ];
  for (const p of candidates) {
    if (p.words.size < 12) continue;
    const home = homeOf(p);
    const own = closeness(p, groupFor(home));
    let best: { name: string; score: number } | null = null;
    for (const name of new Set([...bySection.keys(), section])) {
      if (name === home || name === top(home) || home.startsWith(name + '/')) continue;
      // only pairs that involve this section are of interest in this run
      if (home !== section && name !== section) continue;
      const score = closeness(p, groupFor(name));
      if (!best || score > best.score) best = { name, score };
    }
    if (best && best.score >= 0.12 && best.score > own * 1.5) {
      misplaced.push(
        home === section
          ? `- ${p.path} reads more like "${best.name}" (${pct(best.score)} shared vocabulary) than its neighbours here (${pct(own)})`
          : `- ${p.path} (in "${home}") reads more like this section (${pct(best.score)} shared vocabulary) than its own (${pct(own)})`,
      );
    }
  }
  if (misplaced.length) {
    lines.push('', 'Pages that may be in the wrong place (a hint only; check what each page is about):');
    lines.push(...misplaced.slice(0, 6));
    findings += Math.min(misplaced.length, 6);
  }

  // Folders of pages with no page of their own, or an overview with almost nothing on it
  const overview: string[] = [];
  const prefixes = new Map<string, number>();
  for (const p of mine) {
    for (let q = parentOf(p.path); q && inSection(q, section); q = parentOf(q)) prefixes.set(q, (prefixes.get(q) ?? 0) + 1);
  }
  for (const [prefix, below] of prefixes) {
    const page = all.find((p) => p.path === prefix);
    const kids = mine.filter((p) => parentOf(p.path) === prefix).length;
    // a folder with a single page does not need an overview
    if (!page && below >= 2 && !suggestedNew.has(prefix)) {
      overview.push(`- ${prefix} has ${below} page${below > 1 ? 's' : ''} under it but no page of its own`);
    } else if (page && kids >= 2 && bodyChars(page.content) < 120) {
      overview.push(`- ${prefix} has ${kids} sub-pages but almost no text of its own (${bodyChars(page.content)} chars besides headings)`);
    }
  }
  if (overview.length) {
    lines.push('', 'Missing or empty overview pages (an overview says in a few sentences what the pages below cover and links to them; sub-pages are listed automatically):');
    lines.push(...overview.slice(0, 8));
    findings += Math.min(overview.length, 8);
  }

  // Pages with hardly anything on them, often a stub left by filing that belongs inside a neighbour
  const stubs = mine.filter((p) => p.path !== section && bodyChars(p.content) < 160 && !mine.some((q) => parentOf(q.path) === p.path));
  if (stubs.length) {
    lines.push('', 'Very short pages (consider merging each into the closest related page, if one covers the same thing):');
    for (const p of stubs.slice(0, 6)) lines.push(`- ${p.path} (${bodyChars(p.content)} chars of text)`);
    findings += Math.min(stubs.length, 6);
  }

  // Links to pages that do not exist, with the likeliest intended page
  const broken: string[] = [];
  for (const p of mine) {
    for (const raw of linksIn(p.content)) {
      const target = safePath(raw);
      if (!target || known.has(target) || suggestedNew.has(target)) continue;
      const last = target.split('/').pop()!;
      const guess = all.find((q) => q.path.split('/').pop() === last) ?? all.find((q) => q.title.toLowerCase() === last.replace(/-/g, ' '));
      broken.push(`- ${p.path} links to "${raw}", which does not exist${guess ? `; probably meant ${guess.path}` : ''}`);
    }
  }
  if (broken.length) {
    lines.push('', 'Broken links (fix the link with replace_in_page, or remove it if nothing fits):');
    lines.push(...[...new Set(broken)].slice(0, 10));
    findings += Math.min(broken.length, 10);
  }

  // Where the pages were filed from. Pages from the same folder that ended up in different
  // sections are often worth a look; the folder layout is a hint, not a structure to copy.
  const origins = folderOrigins();
  const fromHere = mine.filter((p) => origins.has(p.path));
  if (fromHere.length) {
    lines.push('', 'Watched folders these pages were filed from (a hint about what belongs together, not a layout to copy):');
    for (const p of fromHere.slice(0, 15)) lines.push(`- ${p.path}: ${clip([...origins.get(p.path)!].join(', '), 160)}`);
    const dirs = new Set(fromHere.flatMap((p) => [...origins.get(p.path)!]));
    const elsewhere = [...origins.entries()].filter(([page, ds]) => !inSection(page, section) && known.has(page) && [...ds].some((d) => dirs.has(d)));
    if (elsewhere.length) {
      lines.push('Pages in other sections filed from the same folders:');
      for (const [page, ds] of elsewhere.slice(0, 8)) lines.push(`- ${page}: ${clip([...ds].filter((d) => dirs.has(d)).join(', '), 160)}`);
      findings += Math.min(elsewhere.length, 8);
    }
    const labels = new Set(fromHere.flatMap((p) => [...origins.get(p.path)!].map((d) => d.replace(/(: .*| \(top level\))$/, ''))));
    const map = folderMap(known, labels, 30);
    if (map.length) lines.push('', FOLDER_MAP_HEADER, ...map);
  }

  const ops = pendingOpsIn(section);
  if (ops.length) {
    lines.push('', 'Already suggested and waiting for review (do not suggest these again):');
    for (const o of ops.slice(0, 10)) lines.push(`- ${o.kind === 'move' ? `move ${o.path} to ${o.newPath}` : `remove ${o.path}`}: "${clip(o.summary, 100)}"`);
  }

  if (!findings) lines.push('', 'The survey found nothing obvious. Look at the page list for anything that is clearly out of place; if nothing is, say the section is tidy.');
  return { section, pages: mine.length, findings, report: lines.join('\n') };
}

export const isWhole = (s: string) => [WHOLE, '', 'all', 'whole', 'whole wiki', 'the whole wiki', 'wiki', 'index'].includes(s.trim().toLowerCase());

// The shape of the whole wiki: its sections and what they hold, the home page, sections that are
// too small to stand alone, pages that repeat or belong in another section, and the watched folders
export async function surveyWiki(): Promise<Survey> {
  const all = await loadPages();
  const known = new Set(all.map((p) => p.path));
  const bySection = bySectionOf(all);
  const lines: string[] = [];
  let findings = 0;
  if (!bySection.size) return { section: WHOLE, pages: all.length, findings: 0, report: 'The wiki only has its home page.' };

  lines.push(`The whole wiki: ${all.length} pages in ${bySection.size} top-level sections.`, '', 'Sections (path "title" (pages): what its overview says; what is directly inside):');
  const SECTIONS_MAX = 40;
  const names = [...bySection.keys()].sort();
  for (const name of names.slice(0, SECTIONS_MAX)) {
    const pages = bySection.get(name)!;
    const own = pages.find((p) => p.path === name);
    const kids = new Map<string, number>();
    for (const p of pages) {
      if (p.path === name) continue;
      const child = p.path.split('/')[1];
      kids.set(child, (kids.get(child) ?? 0) + 1);
    }
    const inside = [...kids.entries()].slice(0, 12).map(([k, n]) => (n > 1 ? `${k} (${n})` : k));
    lines.push(
      `- ${name} "${own?.title ?? name}" (${pages.length}): ${own ? gist(own.content) || '(overview has no text)' : '(no overview page)'}` +
        (inside.length ? `; inside: ${inside.join(', ')}${kids.size > 12 ? ', ...' : ''}` : ''),
    );
  }
  if (names.length > SECTIONS_MAX) lines.push(`...and ${names.length - SECTIONS_MAX} more sections`);

  // The home page is the map of the wiki: it should point at every section
  const home = all.find((p) => p.path === 'index');
  const linked = new Set((home ? linksIn(home.content) : []).map((l) => safePath(l)).filter(Boolean).map((l) => top(l!)));
  const unlinked = names.filter((n) => !linked.has(n));
  const homeIssues: string[] = [];
  if (!home) homeIssues.push('- There is no home page (index).');
  else if (unlinked.length) homeIssues.push(`- The home page (index) does not link to: ${unlinked.slice(0, 20).join(', ')}${unlinked.length > 20 ? ', ...' : ''}`);
  const noOverview = names.filter((n) => !bySection.get(n)!.some((p) => p.path === n) && bySection.get(n)!.length >= 2);
  if (noOverview.length) homeIssues.push(`- Sections with no overview page of their own: ${noOverview.slice(0, 20).join(', ')}`);
  if (homeIssues.length) {
    lines.push('', 'Home page and overviews (the home page should be a short map that links every section):', ...homeIssues);
    findings += homeIssues.length;
  }

  // Sections too small to stand alone, with the section they read most like
  const small: string[] = [];
  for (const name of names) {
    const pages = bySection.get(name)!;
    if (pages.length > 2) continue;
    let best: { name: string; score: number } | null = null;
    for (const other of names) {
      if (other === name) continue;
      const score = Math.max(...pages.map((p) => closeness(p, bySection.get(other)!)));
      if (!best || score > best.score) best = { name: other, score };
    }
    small.push(`- ${name} (${pages.length} page${pages.length > 1 ? 's' : ''})${best && best.score >= 0.08 ? `; reads most like "${best.name}" (${pct(best.score)} shared vocabulary)` : ''}`);
  }
  if (small.length && names.length > 1) {
    lines.push('', 'Small sections (fold each into a better home with move_page if one fits; a section can also stand on its own if it is a real topic):', ...small.slice(0, 10));
    findings += Math.min(small.length, 10);
  }

  // Pages that repeat a page in another section
  const dupes = duplicatePairs(all.filter((p) => p.path !== 'index'), all, (a, b) => b.path === 'index' || top(a.path) === top(b.path) || b.path < a.path);
  if (dupes.length) {
    lines.push('', 'Possible duplicates across sections (read both before deciding; a merge keeps one page and removes the other):');
    for (const d of dupes.slice(0, 10)) lines.push(`- ${d.a.path} and ${d.b.path}: ${d.why}`);
    findings += Math.min(dupes.length, 10);
  }

  // Pages that read more like another section than their own
  const misplaced: { line: string; gap: number }[] = [];
  for (const p of all) {
    if (p.path === 'index' || p.words.size < 12 || bySection.get(top(p.path))!.length < 2) continue;
    const own = closeness(p, bySection.get(top(p.path))!);
    let best: { name: string; score: number } | null = null;
    for (const name of names) {
      if (name === top(p.path)) continue;
      const score = closeness(p, bySection.get(name)!);
      if (!best || score > best.score) best = { name, score };
    }
    if (best && best.score >= 0.12 && best.score > own * 1.5) {
      misplaced.push({ line: `- ${p.path} reads more like "${best.name}" (${pct(best.score)}) than its own section (${pct(own)})`, gap: best.score - own });
    }
  }
  if (misplaced.length) {
    lines.push('', 'Pages that may be in the wrong section (a hint only; check what each page is about):');
    lines.push(...misplaced.sort((a, b) => b.gap - a.gap).slice(0, 10).map((m) => m.line));
    findings += Math.min(misplaced.length, 10);
  }

  const map = folderMap(known);
  if (map.length) lines.push('', FOLDER_MAP_HEADER, ...map.slice(0, 160));

  const ops = pendingOpsIn('');
  if (ops.length) {
    lines.push('', 'Already suggested and waiting for review (do not suggest these again):');
    for (const o of ops.slice(0, 15)) lines.push(`- ${o.kind === 'move' ? `move ${o.path} to ${o.newPath}` : `remove ${o.path}`}: "${clip(o.summary, 100)}"`);
  }
  if (!findings) lines.push('', 'The survey found nothing obvious at the top level. If the sections already make sense, say the wiki is tidy.');
  return { section: WHOLE, pages: all.length, findings, report: lines.join('\n') };
}

// The wiki's sections in a few lines, for anyone placing new pages: the structure the librarian keeps
export async function sectionGuide(): Promise<string> {
  const bySection = bySectionOf(await loadPages());
  if (!bySection.size) return '';
  const lines = [...bySection.keys()]
    .sort()
    .slice(0, 40)
    .map((name) => {
      const pages = bySection.get(name)!;
      const own = pages.find((p) => p.path === name);
      const kids = [...new Set(pages.filter((p) => p.path !== name).map((p) => p.path.split('/')[1]))].slice(0, 8);
      return `- ${name} (${pages.length} page${pages.length > 1 ? 's' : ''})${own ? `: ${gist(own.content, 100)}` : ''}${kids.length ? ` [${kids.join(', ')}]` : ''}`;
    });
  return lines.join('\n');
}

// What the tidy run asks the assistant to do; the survey follows it
export function tidyInstruction(section: string, limit: number, survey: string): string {
  const scope = section === WHOLE ? 'the whole wiki' : `the "${section}" section of the wiki`;
  return (
    `Librarian pass over ${scope}. You can suggest changes to up to ${limit} pages in this run; work through what helps readers most first. ` +
    'Read every page you change, and both pages before a merge. Leave alone anything that is already tidy, and say so.\n\n' +
    `<<<Survey>>>\n${survey}\n<<<End of survey>>>`
  );
}
