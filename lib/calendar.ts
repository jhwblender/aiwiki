// A calendar lives in a page as a fenced ```calendar block: one line per item,
//   2026-11-05 SoloPulse integration test
//   2026-11-10 | Radar review with the team | bring the harness
// or a run of days, written as first day / last day:
//   2026-12-21/2027-01-03 Winter break
// with an optional `| note` after the title. Editing it as text keeps the page's markdown the one
// source of truth: the calendar renders from it, searches index it, review diffs and the approval
// history treat it like any other block. These functions change the block's text for an AI
// suggestion; the calendar view parses the same lines for display.

export type CalEntry = { date: string; end?: string; title: string; note: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// A runaway span should not flood a month view, however the dates were mistyped
const SPAN_MAX_DAYS = 400;

export function parseCalendar(block: string): CalEntry[] {
  const out: CalEntry[] = [];
  for (const raw of block.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const date = line.slice(0, 10);
    if (!DAY.test(date)) continue;
    let rest = line.slice(10);
    let end: string | undefined;
    if (rest.startsWith('/') && DAY.test(rest.slice(1, 11))) {
      end = rest.slice(1, 11);
      rest = rest.slice(11);
    }
    const [head = '', ...tail] = rest.split('|');
    out.push({ date, end, title: head.trim(), note: tail.join('|').trim() });
  }
  return out;
}

// Every day an entry covers, inclusive, as calendar dates; a single day stays a single day
export function daysOf(entry: { date: string; end?: string }): string[] {
  if (!entry.end || !DAY.test(entry.end) || entry.end < entry.date) return [entry.date];
  const out: string[] = [];
  let t = new Date(entry.date + 'T00:00:00Z').getTime();
  const last = Math.min(new Date(entry.end + 'T00:00:00Z').getTime(), t + SPAN_MAX_DAYS * 86_400_000);
  while (t <= last) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

// The one calendar block on a page: where its item lines start and where the whole block ends.
// A page with several blocks is still fine: the tools change the first, and the view renders each.
export function findCalendarBlock(content: string): { textStart: number; end: number; text: string } | null {
  const m = content.match(/```calendar[ \t]*\r?\n([\s\S]*?)```/);
  if (!m || m.index === undefined) return null;
  const textStart = m.index + m[0].indexOf('\n') + 1;
  return { textStart, end: m.index + m[0].length, text: m[1] ?? '' };
}

function lineFor(entry: CalEntry): string {
  const span = entry.end && DAY.test(entry.end) && entry.end >= entry.date ? `/${entry.end}` : '';
  const tail = entry.title || entry.note ? ` ${entry.title}${entry.note ? ` | ${entry.note}` : ''}`.trimEnd() : '';
  return `${entry.date}${span}${tail}`;
}

function wrap(content: string, found: { textStart: number; end: number }, lines: string[]): string {
  let text = lines.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  // content between the entry lines and here is the block's own closing fence
  const closeAt = found.end - 3;
  return content.slice(0, found.textStart) + text + content.slice(closeAt);
}

// Insert the line in date order among the entry lines (a run sorts by its first day); lines the
// calendar does not understand stay where they are, after the entries. A page without a block
// gains one at the end.
export function addCalendarEntry(content: string, entry: { date: string; end?: string; title: string; note?: string }): string {
  const found = findCalendarBlock(content);
  const clean = (s?: string) => (s ?? '').replace(/\r?\n/g, ' ').trim();
  const full = { date: entry.date, end: entry.end, title: clean(entry.title), note: clean(entry.note) };
  const line = lineFor(full);
  if (!found) {
    const lead = content.length === 0 ? '' : content.endsWith('\n\n') || content.endsWith('\n```') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    return `${content}${lead}\`\`\`calendar\n${line}\n\`\`\`\n`;
  }
  const lines = found.text.replace(/\r/g, '').split('\n');
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const d = lines[i].trim().slice(0, 10);
    if (DAY.test(d) && d > full.date) {
      insertAt = i;
      break;
    }
  }
  if (insertAt === -1) {
    let lastEntry = -1;
    for (let i = 0; i < lines.length; i++) if (/^\d{4}-\d{2}-\d{2}/.test(lines[i].trim())) lastEntry = i;
    insertAt = lastEntry + 1;
  }
  lines.splice(insertAt, 0, line);
  return wrap(content, found, lines);
}

// Take matching lines out of the block. With a title, everything by that title goes (a run of days
// included); with only a day, exactly one item must touch that day - a day inside a run counts as
// touching it. Returns null when there is no block, or the removal is ambiguous or finds nothing,
// so a tool can report cleanly.
export function removeCalendarEntry(content: string, date: string, title?: string): string | null {
  const found = findCalendarBlock(content);
  if (!found) return null;
  const wantTitle = (title ?? '').trim().toLowerCase();
  const lines = found.text.replace(/\r/g, '').split('\n');
  const removals: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const entry = parseCalendar(lines[i])[0];
    if (!entry) continue;
    const touches = daysOf(entry).includes(date);
    if (!touches) continue;
    if (wantTitle) {
      if (entry.title.toLowerCase() === wantTitle) removals.push(i);
    } else {
      removals.push(i);
    }
  }
  if (!removals.length) return null;
  if (!wantTitle && removals.length > 1) return null;
  const kept = lines.filter((_, i) => !removals.includes(i));
  return wrap(content, found, kept);
}
