import { diffArrays } from 'diff';
import crypto from 'node:crypto';
import type { Segment } from './types';

// The wiki diffs at paragraph level (blocks separated by blank lines).
// A "hunk" is one run of removed and/or added blocks, and is the unit a reviewer approves or rejects.

export function toBlocks(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.replace(/^\n+|\n+$/g, ''))
    .filter((b) => b.trim().length > 0);
}

export function fromBlocks(blocks: string[]): string {
  return blocks.length ? blocks.join('\n\n') + '\n' : '';
}

export function normalize(text: string): string {
  return fromBlocks(toBlocks(text));
}

function fingerprint(removed: string[], added: string[]): string {
  return crypto
    .createHash('sha1')
    .update(removed.join('\u0000') + '\u0001' + added.join('\u0000'))
    .digest('hex')
    .slice(0, 10);
}

export function segments(oldText: string, newText: string): Segment[] {
  const parts = diffArrays(toBlocks(oldText), toBlocks(newText));
  const out: Segment[] = [];
  let cur: Extract<Segment, { type: 'change' }> | null = null;
  let idx = 0;
  for (const p of parts) {
    if (p.added || p.removed) {
      if (!cur) {
        cur = { type: 'change', index: idx++, fp: '', removed: [], added: [] };
        out.push(cur);
      }
      (p.added ? cur.added : cur.removed).push(...(p.value as string[]));
    } else {
      cur = null;
      out.push({ type: 'same', blocks: p.value as string[] });
    }
  }
  for (const s of out) if (s.type === 'change') s.fp = fingerprint(s.removed, s.added);
  return out;
}

export function hunkCount(segs: Segment[]): number {
  return segs.filter((s) => s.type === 'change').length;
}

// Apply or discard a single hunk. Returns the new live content and the remaining proposal.
export function resolveHunk(
  oldText: string,
  newText: string,
  index: number,
  mode: 'approve' | 'reject',
): { current: string; proposed: string } {
  const cur: string[] = [];
  const prop: string[] = [];
  for (const s of segments(oldText, newText)) {
    if (s.type === 'same') {
      cur.push(...s.blocks);
      prop.push(...s.blocks);
    } else {
      const target = s.index === index;
      cur.push(...(target && mode === 'approve' ? s.added : s.removed));
      prop.push(...(target && mode === 'reject' ? s.removed : s.added));
    }
  }
  return { current: fromBlocks(cur), proposed: fromBlocks(prop) };
}

// ---------- keeping suggestions current ----------
// A suggestion is written against the page as it was then (its base). When the page changes
// underneath it, replay the suggestion's own changes onto the live page so approving it never
// undoes someone else's edit. Returns null when both touched the same paragraphs.

type Span = { start: number; end: number; added: string[] }; // replaces base[start, end)

function spans(base: string[], next: string[]): Span[] {
  const out: Span[] = [];
  let pos = 0;
  let cur: Span | null = null;
  for (const p of diffArrays(base, next)) {
    const n = p.value.length;
    if (p.added || p.removed) {
      if (!cur) {
        cur = { start: pos, end: pos, added: [] };
        out.push(cur);
      }
      if (p.removed) {
        cur.end += n;
        pos += n;
      } else cur.added.push(...(p.value as string[]));
    } else {
      cur = null;
      pos += n;
    }
  }
  return out;
}

function clash(a: Span, b: Span): boolean {
  if (a.start === b.start) return true;
  return a.start < b.end && b.start < a.end;
}

export function rebase(baseText: string, proposedText: string, liveText: string): string | null {
  const base = toBlocks(baseText);
  const ours = spans(base, toBlocks(proposedText));
  const theirs = spans(base, toBlocks(liveText));
  const merged: Span[] = [...theirs];
  for (const o of ours) {
    const hit = theirs.find((t) => clash(o, t));
    if (!hit) merged.push(o);
    else if (hit.start !== o.start || hit.end !== o.end || hit.added.join('\u0000') !== o.added.join('\u0000')) return null;
    // identical change on both sides: already in the live page
  }
  merged.sort((a, b) => a.start - b.start);
  const out: string[] = [];
  let pos = 0;
  for (const s of merged) {
    out.push(...base.slice(pos, s.start), ...s.added);
    pos = s.end;
  }
  out.push(...base.slice(pos));
  return fromBlocks(out);
}
