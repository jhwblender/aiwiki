'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';
import type { PluggableList } from 'unified';
import { usePages } from './WikiContext';

export function slugify(s: string): string {
  return s
    .replace(/\.md$/i, '')
    .split('/')
    .map((p) => p.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_.]/g, ''))
    .filter(Boolean)
    .join('/');
}

// [[path]] shows the page title; [[path|label]] shows the label.
const UNLABELED = 'wiki:auto';

function wikiLinks(md: string): string {
  return md.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => {
    const href = `/wiki/${slugify(target)}`;
    return label ? `[${label.trim()}](${href})` : `[${target.trim()}](${href} "${UNLABELED}")`;
  });
}

export default function Md({ children, rehypePlugins }: { children: string; rehypePlugins?: PluggableList }) {
  const pages = usePages();
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins}
      components={{
        a({ href, title, children }) {
          if (href && href.startsWith('/wiki/')) {
            const page = pages.get(href.slice('/wiki/'.length));
            const missing = pages.size > 0 && !page;
            return (
              <Link href={href} className={missing ? 'missing-link' : undefined} title={missing ? 'This page does not exist yet' : undefined}>
                {title === UNLABELED && page ? page.title : children}
              </Link>
            );
          }
          return (
            <a href={href} title={title} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        },
      }}
    >
      {wikiLinks(children)}
    </ReactMarkdown>
  );
}
