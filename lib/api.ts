import { NextResponse } from 'next/server';

export function fail(e: unknown, status = 400) {
  const message = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: message }, { status });
}

export function userFrom(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.slice(0, 60) || 'anonymous';
}
