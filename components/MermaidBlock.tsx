'use client';
import { useEffect, useRef, useState } from 'react';
import { THEME_EVENT } from '@/lib/theme';
import DiagramViewer from './DiagramViewer';

// A fenced ```mermaid block is a diagram written as markdown text, and it renders as the real
// drawing here. The library is large, so it loads only when a page happens to carry a diagram.
// Source in, drawing out; when the drawing fails, the source stays visible so nothing disappears.

export default function MermaidBlock({ text }: { text: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef(0);
  // Bumped when the wiki switches between light and dark, so the drawing is made again to match
  const [themeTurn, setThemeTurn] = useState(0);

  useEffect(() => {
    const onTheme = () => setThemeTurn((n) => n + 1);
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, []);

  useEffect(() => {
    const run = ++runRef.current;
    let settled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'neutral';
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme });
        const { svg: drawn } = await mermaid.render(`wiki-mermaid-${run}`, text);
        if (run === runRef.current) {
          settled = true;
          setSvg(drawn);
          setError(null);
        }
      } catch (e: any) {
        if (run === runRef.current) {
          settled = true;
          setSvg(null);
          setError(e?.message ?? String(e));
        }
      }
    })();
    return () => {
      // A newer render wins; the older one's result is thrown away
      if (!settled) runRef.current = run + 1;
    };
  }, [text, themeTurn]);

  return (
    <div className="mermaid-block">
      {svg === null && error === null && <p className="muted small-text">Drawing…</p>}
      {error && (
        <>
          <pre className="mermaid-source">{text}</pre>
          <p className="small-text mermaid-error">
            This diagram could not be drawn: {error}
            {/got '|Expecting/.test(error ?? '') && /\[[^\]"']*\([^\)]*\)/.test(text)
              ? ' Parentheses or other marks inside a label need the text in double quotes: AM["McKinney (Alli) - CEO"].'
              : null}
          </p>
        </>
      )}
      {svg !== null && <DiagramViewer svg={svg} />}
    </div>
  );
}
