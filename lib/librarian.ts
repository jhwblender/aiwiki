import { db } from './db';
import { listPages, normalizePath, readPage } from './wiki';
import { pendingCounts } from './proposals';

// The librarian keeps the wiki organised beyond single edits. Before the assistant looks at a
// section, this survey works out what is worth its attention without a model: pages that share
// much of their wording, pages that read like another section, folders of pages with no overview,
// links to pages that do not exist, and which watched folders the pages were filed from. The
// assistant then reads the pages it needs and suggests moves, merges and overview pages through
// the normal suggestion tools. Everything it finds is a hint; nothing here changes the wiki.

// Suggestions per tidy run unless asked otherwise; each page touched counts once
export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 10;

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
  return rows.filter((r) => inSection(r.path, section) || (r.newPath && inSection(r.newPath, section)));
}

export type Survey = { section: string; pages: number; findings: number; report: string };

// A plain-text report on one section for the assistant, kept short enough for a local model
export async function surveySection(sectionInput: string): Promise<Survey> {
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

  // Pages that repeat each other, inside the section or with a page elsewhere
  const dupes: { a: Page; b: Page; why: string; score: number }[] = [];
  for (const a of mine) {
    for (const b of all) {
      if (a.path === b.path || related(a.path, b.path)) continue;
      // each pair once: when both are in the section, only from the alphabetically first
      if (inSection(b.path, section) && b.path < a.path) continue;
      const sameTitle = a.title.toLowerCase() === b.title.toLowerCase();
      const copied = a.shingles.size >= 8 && b.shingles.size >= 8 ? overlap(a.shingles, b.shingles) : 0;
      const topic = a.words.size >= 12 && b.words.size >= 12 ? jaccard(a.words, b.words) : 0;
      const reasons: string[] = [];
      if (sameTitle) reasons.push('same title');
      if (copied >= 0.3) reasons.push(`${pct(copied)} of the shorter page's wording also appears in the other`);
      else if (topic >= 0.4) reasons.push(`${pct(topic)} of their vocabulary is shared`);
      if (reasons.length) dupes.push({ a, b, why: reasons.join('; '), score: copied + topic + (sameTitle ? 0.5 : 0) });
    }
  }
  dupes.sort((x, y) => y.score - x.score);
  if (dupes.length) {
    lines.push('', 'Possible duplicates or overlapping pages (read both before deciding; a merge keeps one page and removes the other):');
    for (const d of dupes.slice(0, 8)) lines.push(`- ${d.a.path} and ${d.b.path}: ${d.why}`);
    findings += Math.min(dupes.length, 8);
  }

  // Pages that read more like another section than their own. Compared by vocabulary with the
  // closest few pages of each top-level section, so one big section does not drown out a small one.
  const closeness = (p: Page, group: Page[]) => {
    const scores = group.filter((q) => q.path !== p.path && !related(p.path, q.path)).map((q) => jaccard(p.words, q.words));
    if (!scores.length) return 0;
    const best = scores.sort((x, y) => y - x).slice(0, 3);
    return best.reduce((s, x) => s + x, 0) / best.length;
  };
  const bySection = new Map<string, Page[]>();
  for (const p of all) {
    if (p.path === 'index') continue;
    if (!bySection.has(top(p.path))) bySection.set(top(p.path), []);
    bySection.get(top(p.path))!.push(p);
  }
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
    const elsewhere = [...origins.entries()].filter(([page, ds]) => !inSection(page, section) && [...ds].some((d) => dirs.has(d)));
    if (elsewhere.length) {
      lines.push('Pages in other sections filed from the same folders:');
      for (const [page, ds] of elsewhere.slice(0, 8)) lines.push(`- ${page}: ${clip([...ds].filter((d) => dirs.has(d)).join(', '), 160)}`);
      findings += Math.min(elsewhere.length, 8);
    }
  }

  const ops = pendingOpsIn(section);
  if (ops.length) {
    lines.push('', 'Already suggested and waiting for review (do not suggest these again):');
    for (const o of ops.slice(0, 10)) lines.push(`- ${o.kind === 'move' ? `move ${o.path} to ${o.newPath}` : `remove ${o.path}`}: "${clip(o.summary, 100)}"`);
  }

  if (!findings) lines.push('', 'The survey found nothing obvious. Look at the page list for anything that is clearly out of place; if nothing is, say the section is tidy.');
  return { section, pages: mine.length, findings, report: lines.join('\n') };
}

// What the tidy run asks the assistant to do; the survey follows it
export function tidyInstruction(section: string, limit: number, survey: string): string {
  return (
    `Librarian pass over the "${section}" section of the wiki. Suggest at most ${limit} changes, the most useful first. ` +
    'Read every page you change, and both pages before a merge. Leave alone anything that is already tidy, and say so.\n\n' +
    `<<<Survey of the section>>>\n${survey}\n<<<End of survey>>>`
  );
}
