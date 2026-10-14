'use client';
import { useEffect, useRef } from 'react';
import type { SourceInfo } from '@/lib/types';

export function sourceSummary(s: SourceInfo | null): string {
  if (!s) return 'Unknown source';
  if (s.kind === 'chat') return `Chat with ${s.user}`;
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

export default function SourceChip({ source }: { source: SourceInfo | null }) {
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
      <summary className="chip">{sourceSummary(source)}</summary>
      <dl className="chip-pop">
        <dt>Contributed by</dt>
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
            </dd>
          </>
        )}
        {source.note && (
          <>
            <dt>Message</dt>
            <dd>{source.note}</dd>
          </>
        )}
        <dt>Received</dt>
        <dd>{when(source.detectedAt)}</dd>
      </dl>
    </details>
  );
}
