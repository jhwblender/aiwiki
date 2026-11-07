'use client';
import { useEffect, useRef, useState } from 'react';

// A fenced ```mermaid block is a diagram written as markdown text, and it renders as the real
// drawing here. The library is large, so it loads only when a page happens to carry a diagram.
// Source in, drawing out; when the drawing fails, the source stays visible so nothing disappears.

export default function MermaidBlock({ text }: { text: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef(0);

  useEffect(() => {
    const run = ++runRef.current;
    let settled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
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
  }, [text]);

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
      {svg !== null && <div className="mermaid-draw" dangerouslySetInnerHTML={{ __html: svg }} />}
    </div>
  );
}
