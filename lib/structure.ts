import { listPages, readPage, titleFor } from './wiki';

// The wiki's structure is never written by hand: it is the tree of pages, generated from what is
// there, so it cannot go out of date. What people and the assistant write is each page's summary:
// the opening paragraph after its title, saying what the page or section covers and what belongs
// in it. The summary lives in the page's markdown like any other text.

const MAX_SUMMARY = 600;

const isProse = (block: string) => !/^\s*(#{1,6}\s|[-*+|>]|\d+[.)]\s|!\[|```|<)/.test(block);

// Where the summary sits: the first paragraph after the title, if it is prose (not a heading,
// list, table, quote or image). Line numbers are [start, end).
function locate(md: string): { titleLine: number; start: number; end: number } | { titleLine: number; start: null; end: null } {
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const titleLine = i < lines.length && /^#\s/.test(lines[i]) ? i : -1;
  i = titleLine >= 0 ? titleLine + 1 : i;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length) return { titleLine, start: null, end: null };
  let end = i;
  while (end < lines.length && lines[end].trim()) end++;
  const block = lines.slice(i, end).join('\n');
  return isProse(block) ? { titleLine, start: i, end } : { titleLine, start: null, end: null };
}

export function summaryOf(md: string): string | null {
  const at = locate(md);
  if (at.start === null) return null;
  return md
    .split('\n')
    .slice(at.start, at.end)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanSummary(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) throw new Error('The summary is empty.');
  if (s.length > MAX_SUMMARY) throw new Error(`Keep the summary under ${MAX_SUMMARY} characters; it is one or two sentences.`);
  if (!isProse(s)) throw new Error('The summary is plain sentences, not a heading, list or table.');
  return s;
}

// The page with its summary replaced, or added right under the title. A page that does not exist
// yet (a folder of pages, or a new section) becomes a title and the summary.
export function withSummary(md: string | null, summary: string, path: string, title?: string): string {
  const s = cleanSummary(summary);
  if (md === null || !md.trim()) return `# ${title?.trim() || titleFor('', path)}\n\n${s}\n`;
  const lines = md.split('\n');
  const at = locate(md);
  if (at.start !== null) {
    lines.splice(at.start, at.end - at.start, s);
  } else if (at.titleLine >= 0) {
    lines.splice(at.titleLine + 1, 0, '', s);
  } else {
    lines.unshift(`# ${title?.trim() || titleFor(md, path)}`, '', s, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export type StructureNode = {
  path: string;
  title: string;
  exists: boolean; // a folder of pages may have no page of its own
  summary: string | null;
  pages: number; // pages at and under this path
  children: StructureNode[];
};

// The tree of every page, with each page's summary; index (the home page) is left out of the tree
export async function buildStructure(): Promise<{ home: { title: string; summary: string | null } | null; sections: StructureNode[] }> {
  const pages = await listPages();
  const content = new Map<string, string>();
  for (const p of pages) content.set(p.path, (await readPage(p.path)) ?? '');
  const nodes = new Map<string, StructureNode>();
  const node = (path: string): StructureNode => {
    let n = nodes.get(path);
    if (!n) {
      const md = content.get(path);
      n = { path, title: md !== undefined ? titleFor(md, path) : titleFor('', path), exists: md !== undefined, summary: md ? summaryOf(md) : null, pages: 0, children: [] };
      nodes.set(path, n);
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
      if (parent) node(parent).children.push(n);
    }
    return n;
  };
  for (const p of pages) {
    if (p.path === 'index') continue;
    node(p.path);
    for (let q: string | null = p.path; q; q = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : null) node(q).pages++;
  }
  const sort = (list: StructureNode[]) => {
    list.sort((a, b) => a.title.localeCompare(b.title));
    for (const n of list) sort(n.children);
    return list;
  };
  const home = content.get('index');
  return {
    home: home === undefined ? null : { title: titleFor(home, 'index'), summary: summaryOf(home) },
    sections: sort([...nodes.values()].filter((n) => !n.path.includes('/'))),
  };
}

// The structure as text for the assistant: every section with its summary, and the pages in it.
// Pages with nothing under them are listed by name only, to keep it short.
export async function structureOutline(maxLines = 120): Promise<string> {
  const { sections } = await buildStructure();
  const lines: string[] = [];
  const walk = (n: StructureNode, depth: number) => {
    if (lines.length >= maxLines) return;
    const pad = '  '.repeat(depth);
    const leaves = n.children.filter((c) => !c.children.length);
    const branches = n.children.filter((c) => c.children.length);
    const what = n.summary ? `: ${n.summary.length > 200 ? n.summary.slice(0, 197) + '...' : n.summary}` : n.children.length ? ': (no summary yet)' : '';
    lines.push(`${pad}- ${n.path} "${n.title}"${n.children.length ? ` (${n.pages} pages)` : ''}${n.exists ? '' : ' [folder with no page of its own]'}${what}`);
    if (leaves.length) {
      const names = leaves.map((l) => l.path.split('/').pop());
      lines.push(`${pad}  pages: ${names.slice(0, 15).join(', ')}${names.length > 15 ? `, and ${names.length - 15} more` : ''}`);
    }
    for (const b of branches) walk(b, depth + 1);
  };
  for (const s of sections) walk(s, 0);
  if (lines.length >= maxLines) lines.push('...(more not shown)');
  return lines.join('\n');
}
