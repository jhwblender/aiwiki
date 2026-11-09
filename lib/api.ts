import { NextRequest, NextResponse } from 'next/server';
import { roleRank, sessionUser, COOKIE_NAME } from '@/lib/auth';
import type { SessionUser } from '@/lib/auth';
import type { Access, Level } from '@/lib/access';

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

// What a route says when this person may not do this on this page. A page they cannot read looks
// the same whether or not it exists.
export function denied(access: Access, path: string, need: Level): NextResponse | null {
  if (access.can(path, need)) return null;
  if (!access.visible(path)) return NextResponse.json({ error: 'This page is not available to you.' }, { status: 404 });
  const what = need === 'suggest' ? 'suggest changes to this page' : need === 'edit' ? 'edit this page' : need === 'approve' ? 'review suggestions on this page' : 'change who can use this page';
  return NextResponse.json({ error: `You do not have permission to ${what}.` }, { status: 403 });
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
