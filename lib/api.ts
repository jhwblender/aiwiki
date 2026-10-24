import { NextRequest, NextResponse } from 'next/server';
import { roleRank, sessionUser, COOKIE_NAME } from '@/lib/auth';
import type { SessionUser } from '@/lib/auth';

export function fail(e: unknown, status = 400) {
  const message = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: message }, { status });
}

// Every route calls this first. The minimum role is checked; the returned user name is what
// edits and suggestions are recorded under, so nobody can post under someone else's name.
export function requireUser(req: NextRequest, minRole: 'viewer' | 'editor' | 'admin' = 'viewer'): SessionUser | NextResponse {
  const user = sessionUser(req);
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  if (roleRank(user.role) < roleRank(minRole)) {
    return NextResponse.json({ error: `Needs the ${minRole} role.` }, { status: 403 });
  }
  return user;
}

export function isResponse(v: unknown): v is NextResponse {
  return v instanceof NextResponse;
}

export function sessionCookie(res: NextResponse, token: string, maxAgeSeconds: number) {
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // the wiki runs on plain http inside the LAN
    maxAge: maxAgeSeconds,
    path: '/',
  });
  return res;
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(COOKIE_NAME, '', { httpOnly: true, sameSite: 'lax', maxAge: 0, path: '/' });
  return res;
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
