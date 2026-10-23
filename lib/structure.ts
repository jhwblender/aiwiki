import { listPages, readPage, titleFor } from './wiki';
import { summaryOf } from './summary';

// The wiki's structure is never written by hand: it is the tree of pages, generated from what is
// there, so it cannot go out of date. What people and the assistant write is each page's summary:
// the opening paragraph after its title, saying what the page or section covers and what belongs
// in it. The summary lives in the page's markdown like any other text.

export { cleanSummary, summaryOf, withSummary } from './summary';

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
