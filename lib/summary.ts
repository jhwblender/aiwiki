// A page's summary is its opening paragraph under the title: plain sentences saying what the page
// or section covers and what belongs in it. Pure text functions, shared by the server and the editor.
// A summary can be changed but never removed, and new pages start with one.

const titleFromPath = (p: string) => (p.split('/').pop() || p).replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

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
  if (md === null || !md.trim()) return `# ${title?.trim() || titleFromPath(path)}\n\n${s}\n`;
  const lines = md.split('\n');
  const at = locate(md);
  if (at.start !== null) {
    lines.splice(at.start, at.end - at.start, s);
  } else if (at.titleLine >= 0) {
    lines.splice(at.titleLine + 1, 0, '', s);
  } else {
    lines.unshift(`# ${title?.trim() || (md.match(/^#\s+(.+)$/m)?.[1].trim() ?? titleFromPath(path))}`, '', s, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// The page split into its summary and everything else, for an editor that shows the summary apart
export function splitSummary(md: string): { summary: string | null; rest: string } {
  const at = locate(md);
  if (at.start === null) return { summary: null, rest: md };
  const lines = md.split('\n');
  const summary = lines.slice(at.start, at.end).join(' ').replace(/\s+/g, ' ').trim();
  lines.splice(at.start, at.end - at.start + (lines[at.end] === '' ? 1 : 0));
  return { summary, rest: lines.join('\n') };
}

// Why a change may not be made: it removes the page's summary, or a new page has none
export function summaryProblem(before: string | null, after: string): string | null {
  if (before !== null && summaryOf(before) && !summaryOf(after)) {
    return 'The summary at the top of the page cannot be removed. Change its wording instead.';
  }
  if (before === null && !summaryOf(after)) {
    return 'A new page needs a summary: one or two sentences under the title saying what the page covers.';
  }
  return null;
}

// Put a summary back in front of text it was split from (see splitSummary). Unlike withSummary, it
// never replaces the first paragraph of the text, which is not the summary once it was split off.
export function joinSummary(rest: string, summary: string): string {
  const s = cleanSummary(summary);
  const lines = rest.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && /^#\s/.test(lines[i])) lines.splice(i + 1, 0, '', s, '');
  else lines.unshift(s, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}
