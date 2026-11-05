// A calendar lives in a page as a fenced ```calendar block: one line per day,
//   2026-11-05 SoloPulse integration test
//   2026-11-10 | Radar review with the team | bring the harness
// with an optional `| note` after the title. Editing it as text keeps the page's markdown the one
// source of truth: the calendar renders from it, searches index it, review diffs and the approval
// history treat it like any other block. These functions change the block's text for an AI
// suggestion; the calendar view parses the same lines for display.

export type CalEntry = { date: string; title: string; note: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseCalendar(block: string): CalEntry[] {
  const out: CalEntry[] = [];
  for (const raw of block.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const date = line.slice(0, 10);
    if (!DAY.test(date)) continue;
    const [head = '', ...rest] = line.slice(10).split('|');
    out.push({ date, title: head.trim(), note: rest.join('|').trim() });
  }
  return out;
}

// The one calendar block on a page: where its entry lines start and where the whole block ends.
// A page with several blocks is still fine: the tools change the first, and the view renders each.
export function findCalendarBlock(content: string): { textStart: number; end: number; text: string } | null {
  const m = content.match(/```calendar[ \t]*\r?\n([\s\S]*?)```/);
  if (!m || m.index === undefined) return null;
  const textStart = m.index + m[0].indexOf('\n') + 1;
  return { textStart, end: m.index + m[0].length, text: m[1] ?? '' };
}

function wrap(content: string, found: { textStart: number; end: number }, lines: string[]): string {
  let text = lines.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  // content between the entry lines and here is the block's own closing fence
  const closeAt = found.end - 3;
  return content.slice(0, found.textStart) + text + content.slice(closeAt);
}

// Insert the entry in date order among the parseable lines; lines the calendar does not
// understand stay where they are, after the entries. A page without a block gains one at the end.
export function addCalendarEntry(content: string, entry: { date: string; title: string; note?: string }): string {
  const found = findCalendarBlock(content);
  const line = `${entry.date} ${entry.title}${entry.note ? ` | ${entry.note}` : ''}`.replace(/\s+$/, '');
  if (!found) {
    const lead = content.length === 0 ? '' : content.endsWith('\n\n') || content.endsWith('\n```') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    return `${content}${lead}\`\`\`calendar\n${line}\n\`\`\`\n`;
  }
  const lines = found.text.replace(/\r/g, '').split('\n');
  let lastEntry = -1;
  for (let i = 0; i < lines.length; i++) if (/^\d{4}-\d{2}-\d{2}/.test(lines[i].trim())) lastEntry = i;
  lines.splice(lastEntry + 1, 0, line);
  return wrap(content, found, lines);
}

// Take matching lines out of the block. A title narrows the match when one day holds several
// entries; returns null when there is no block or nothing matching, so a tool can report cleanly.
export function removeCalendarEntry(content: string, date: string, title?: string): string | null {
  const found = findCalendarBlock(content);
  if (!found) return null;
  const wantTitle = (title ?? '').trim().toLowerCase();
  let removed = 0;
  const kept = found.text.replace(/\r/g, '').split('\n').filter((raw) => {
    const line = raw.trim();
    const hit = line.startsWith(date) && (line.length === 10 || /\s/.test(line.slice(10)));
    if (!hit) return true;
    if (wantTitle) {
      const e = parseCalendar(line);
      if (!e.length || e[0].title.toLowerCase() !== wantTitle) return true;
    }
    removed++;
    return false;
  });
  if (!removed) return null;
  return wrap(content, found, kept);
}
