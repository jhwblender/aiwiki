'use client';
import { createContext, useContext, type ReactNode } from 'react';
import type { Root, Element, ElementContent, Text } from 'hast';

// While a search is open, the words searched for are marked lightly on the page being read and
// in the result snippets. Matching follows search itself: a keyword matches the start of a word.

export const SearchWords = createContext<string[]>([]);
export const useSearchWords = () => useContext(SearchWords);

// The same keywords search uses (lib/wiki.ts searchPages)
export function searchTerms(q: string): string[] {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The whole word whose start matches one of the terms
function matcher(terms: string[]): RegExp | null {
  if (!terms.length) return null;
  const alts = [...terms].sort((a, b) => b.length - a.length).map(escape).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts})[\\p{L}\\p{N}_]*`, 'giu');
}

function split(text: string, re: RegExp): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

// Code is left alone: calendars and diagrams are drawn from their text
const SKIP = new Set(['code', 'pre', 'script', 'style']);

export function rehypeSearchMarks(terms: string[]) {
  const re = matcher(terms);
  return () => (tree: Root) => {
    if (!re) return;
    const walk = (node: Root | Element) => {
      const next: ElementContent[] = [];
      for (const child of node.children as ElementContent[]) {
        if (child.type === 'text') {
          const parts = split(child.value, re);
          if (parts.some((p) => p.hit)) {
            for (const p of parts)
              next.push(
                p.hit
                  ? { type: 'element', tagName: 'mark', properties: { className: ['search-mark'] }, children: [{ type: 'text', value: p.text } as Text] }
                  : ({ type: 'text', value: p.text } as Text),
              );
            continue;
          }
        } else if (child.type === 'element' && !SKIP.has(child.tagName)) walk(child);
        next.push(child);
      }
      node.children = next as typeof node.children;
    };
    walk(tree);
  };
}

// A snippet from search with its words marked. Search wraps matches in [ ]; those brackets go
export function MarkedText({ text, terms }: { text: string; terms: string[] }) {
  const re = matcher(terms);
  const plain = text.replace(/\n+/g, ' ').replace(/\[([^[\]\n]+)\]/g, (whole, inner: string) => (re && new RegExp(`^(?:${re.source})$`, 'iu').test(inner) ? inner : whole));
  if (!re) return <>{plain}</>;
  const out: ReactNode[] = split(plain, re).map((p, i) => (p.hit ? <mark key={i} className="search-mark">{p.text}</mark> : p.text));
  return <>{out}</>;
}
