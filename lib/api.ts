import { NextResponse } from 'next/server';

export function fail(e: unknown, status = 400) {
  const message = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: message }, { status });
}

export function userFrom(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.slice(0, 60) || 'anonymous';
}

export function fileResponse(f: { filename: string; mime: string }, data: Buffer) {
  // Only images and PDFs open in the browser; anything else downloads
  const inline = /^image\/|^application\/pdf$/.test(f.mime);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      'Content-Type': f.mime,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
