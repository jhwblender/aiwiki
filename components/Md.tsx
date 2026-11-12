'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { PluggableList } from 'unified';
import { usePages } from './WikiContext';
import CalendarBlock from './CalendarBlock';
import MermaidBlock from './MermaidBlock';
import { rehypeSearchMarks, useSearchWords } from './searchMarks';

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

// Pull the plain text out of a rendered code block (a nested element graph)
export function codeTextOf(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(codeTextOf).join('');
  const own = (node as { props?: { children?: unknown } }).props;
  return own ? codeTextOf(own.children) : '';
}

// Copies through the clipboard API where the browser allows it (https, localhost) and through a
// hidden textarea everywhere else, like the wiki reaching its machine over plain http on the LAN
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const t = document.createElement('textarea');
      t.value = text;
      t.style.position = 'fixed';
      t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      const ok = document.execCommand('copy');
      t.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// The language written on a fenced block (```json), if it has one
function langOf(children: ReactNode): string {
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    const cls = (c as { props?: { className?: string } } | null)?.props?.className;
    const lang = cls?.match(/language-([^ ]+)/)?.[1];
    if (lang) return lang;
  }
  return '';
}

function CopyCode(props: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const lang = langOf(props.children);
  return (
    <div className={'code-wrap' + (lang ? ' has-lang' : '')}>
      {lang && <span className="code-lang">{lang}</span>}
      <button
        type="button"
        className={'copy-code' + (copied ? ' done' : '')}
        onClick={async () => {
          if (await copyText(codeTextOf(props.children))) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre>{props.children}</pre>
    </div>
  );
}

export default function Md({ children, rehypePlugins }: { children: string; rehypePlugins?: PluggableList }) {
  const pages = usePages();
  const words = useSearchWords();
  const plugins = words.length ? [...(rehypePlugins ?? []), rehypeSearchMarks(words)] : rehypePlugins;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={plugins}
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
        // Fenced blocks with a meaning render as the thing itself: ```calendar becomes a month
        // view, ```mermaid becomes a diagram; every other code block keeps its copy button and
        // its language label
        code({ className, children }) {
          const text = Array.isArray(children) ? children.map(String).join('') : String(children);
          if (String(className ?? '').includes('language-calendar')) return <CalendarBlock text={text} />;
          if (String(className ?? '').includes('language-mermaid')) return <MermaidBlock text={text} />;
          return (
            <code className={className}>
              {children}
            </code>
          );
        },
        pre(props) {
          // Calendars and diagrams draw themselves, so they skip the code frame and its Copy button
          const code: any = props.node?.children?.find((c: any) => c.type === 'element' && c.tagName === 'code');
          const cls = String(code?.properties?.className ?? '');
          if (/language-(calendar|mermaid)\b/.test(cls)) return <>{props.children}</>;
          return <CopyCode {...props} />;
        },
      }}
    >
      {wikiLinks(children)}
    </ReactMarkdown>
  );
}
