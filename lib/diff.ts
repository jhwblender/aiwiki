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
