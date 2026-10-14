'use client';
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
  if (!source) return <span className="chip">Unknown source</span>;
  const where = [source.folderLabel, source.relPath].filter(Boolean).join(' / ');
  return (
    <details className="chip-wrap">
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
