'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';

export function slugify(s: string): string {
  return s
    .replace(/\.md$/i, '')
    .split('/')
    .map((p) => p.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_.]/g, ''))
    .filter(Boolean)
    .join('/');
}

function wikiLinks(md: string): string {
  return md.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => {
    return `[${(label || target).trim()}](/wiki/${slugify(target)})`;
  });
}

export default function Md({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a({ href, children }) {
          if (href && href.startsWith('/wiki/')) return <Link href={href}>{children}</Link>;
          return (
            <a href={href} target="_blank" rel="noreferrer">
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
