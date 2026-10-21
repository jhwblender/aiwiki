import { diffArrays, diffWordsWithSpace } from 'diff';
import type { Root, Element, ElementContent, RootContent } from 'hast';

// Inside an edited paragraph, highlight the words that actually changed so a reviewer
// does not have to compare two near-identical paragraphs by eye.
//
// Changed runs are wrapped in private-use marker characters in the markdown source, and
// a small rehype plugin turns the markers into <mark> elements after rendering.

const OPEN = '\uE000';
const CLOSE = '\uE001';

// Runs touching markdown syntax are left unmarked rather than risk breaking the rendering.
const UNSAFE = /[*_`[\]<>#|~\n\\]|:\/\/|^\s*(\d+[.)]|[-+>])\s/;

function wrap(run: string): string {
  const m = run.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  if (!m[2] || UNSAFE.test(run)) return run;
  return m[1] + OPEN + m[2] + CLOSE + m[3];
}

// Returns the old and new paragraph with changed words marked, or null when the
// paragraphs are too different for word highlighting to help.
export function markWords(oldText: string, newText: string): { removed: string; added: string } | null {
  const parts = diffWordsWithSpace(oldText, newText);
  let same = 0;
  for (const p of parts) if (!p.added && !p.removed) same += p.value.trim().length;
  const longest = Math.max(oldText.trim().length, newText.trim().length);
  if (!longest || same / longest < 0.4) return null;
  const oldSide: Piece[] = [];
  const newSide: Piece[] = [];
  for (const p of parts) {
    if (!p.added) oldSide.push({ text: p.value, changed: !!p.removed });
    if (!p.removed) newSide.push({ text: p.value, changed: !!p.added });
  }
  return { removed: render(oldSide), added: render(newSide) };
}

type Piece = { text: string; changed: boolean };

// Join changed words separated only by spaces into one highlight, then wrap each run.
function render(pieces: Piece[]): string {
  const merged: Piece[] = [];
  pieces.forEach((p, i) => {
    const bridge = !p.changed && /^[ \t]+$/.test(p.text) && pieces[i - 1]?.changed && pieces[i + 1]?.changed;
    const changed = p.changed || !!bridge;
    const last = merged[merged.length - 1];
    if (last && last.changed === changed) last.text += p.text;
    else merged.push({ text: p.text, changed });
  });
  return merged.map((p) => (p.changed ? wrap(p.text) : p.text)).join('');
}

// ---------- tables ----------

const isTable = (block: string) => block.split('\n').every((l) => l.trim().startsWith('|'));
const isSeparator = (line: string) => /^\|?[\s:|-]+\|?$/.test(line.trim());

// Mark the text of every cell in a row
function markRow(line: string): string {
  if (isSeparator(line)) return line;
  return line.replace(/\|([^|]+)(?=\|)/g, (whole, cell: string) => {
    const m = cell.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
    return m[2] ? `|${m[1]}${OPEN}${m[2]}${CLOSE}${m[3]}` : whole;
  });
}

// In an edited table, mark the rows that changed instead of the whole table
export function markTableRows(oldTable: string, newTable: string): { removed: string; added: string } | null {
  if (!isTable(oldTable) || !isTable(newTable)) return null;
  const oldRows: string[] = [];
  const newRows: string[] = [];
  for (const part of diffArrays(oldTable.split('\n'), newTable.split('\n'))) {
    const rows = part.value as string[];
    if (part.removed) oldRows.push(...rows.map(markRow));
    else if (part.added) newRows.push(...rows.map(markRow));
    else {
      oldRows.push(...rows);
      newRows.push(...rows);
    }
  }
  return { removed: oldRows.join('\n'), added: newRows.join('\n') };
}

export function rehypeMarks(className: string) {
  return () => (tree: Root) => {
    const walk = (node: Root | Element) => {
      const out: (RootContent | ElementContent)[] = [];
      for (const child of node.children) {
        if (child.type === 'text' && /[\uE000\uE001]/.test(child.value)) {
          let marked = false;
          for (const part of child.value.split(/([\uE000\uE001])/)) {
            if (part === OPEN) marked = true;
            else if (part === CLOSE) marked = false;
            else if (part && marked) {
              out.push({ type: 'element', tagName: 'mark', properties: { className: [className] }, children: [{ type: 'text', value: part }] });
            } else if (part) out.push({ type: 'text', value: part });
          }
        } else {
          if (child.type === 'element') walk(child);
          out.push(child);
        }
      }
      node.children = out as typeof node.children;
    };
    walk(tree);
  };
}
