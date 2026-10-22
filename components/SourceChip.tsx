'use client';
import { useEffect, useRef } from 'react';
import type { SourceInfo } from '@/lib/types';

export function sourceSummary(s: SourceInfo | null): string {
  if (!s) return 'Unknown source';
  if (s.kind === 'chat') return `Chat with ${s.user}`;
  if (s.kind === 'librarian') return `Librarian, started by ${s.user}`;
  if (s.kind === 'file') return `${s.filename ?? 'File'} from ${s.user}`;
  return s.user;
}

function when(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

export default function SourceChip({
  source,
  earlier = [],
  also = [],
}: {
  source: SourceInfo | null;
  earlier?: SourceInfo[];
  also?: SourceInfo[];
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  // Close the popover on an outside click or Escape
  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);

  if (!source) return <span className="chip">Unknown source</span>;
  const where = [source.folderLabel, source.relPath].filter(Boolean).join(' / ');
  return (
    <details className="chip-wrap" ref={ref}>
      <summary className="chip">
        {also.length && source.kind === 'file'
          ? `${source.filename} and ${also.length} more from ${source.user}`
          : sourceSummary(source)}
      </summary>
      <dl className="chip-pop">
        <dt>{source.kind === 'librarian' ? 'Started by' : 'Contributed by'}</dt>
        <dd>{source.user}</dd>
        {where && (
          <>
            <dt>Location</dt>
            <dd>{where}</dd>
          </>
        )}
        {source.filename && source.kind === 'file' && (
          <>
            <dt>File</dt>
            <dd>
              {source.filename} (version {source.version})
              {source.hasFile && (
                <>
                  {' '}
                  <a href={`/api/sources/${source.id}/file`} target="_blank" rel="noreferrer">
                    Open original
                  </a>
                </>
              )}
            </dd>
          </>
        )}
        {source.note && (
          <>
            <dt>{source.kind === 'librarian' ? 'Run' : 'Message'}</dt>
            <dd>{source.note}</dd>
          </>
        )}
        {also.length > 0 && (
          <>
            <dt>Also from</dt>
            {also.map((a) => (
              <dd key={a.id} className="earlier">
                {a.hasFile ? (
                  <a href={`/api/sources/${a.id}/file`} target="_blank" rel="noreferrer">
                    {a.filename}
                  </a>
                ) : (
                  sourceSummary(a)
                )}
              </dd>
            ))}
          </>
        )}
        <dt>Received</dt>
        <dd>{when(source.detectedAt)}</dd>
        {earlier.length > 0 && (
          <>
            <dt>Revises earlier messages</dt>
            {earlier.map((e) => (
              <dd key={e.id} className="earlier">
                {e.note || sourceSummary(e)} <span className="muted">({when(e.detectedAt)})</span>
              </dd>
            ))}
          </>
        )}
      </dl>
    </details>
  );
}
