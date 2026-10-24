import { NextRequest, NextResponse } from 'next/server';
import { fail, requireUser, isResponse, sessionCookie, clearSessionCookie } from '@/lib/api';
import { signIn, needsSetup, createUser, createSession, destroySession, shownName } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Sign in. With no accounts yet, {"name","password","confirm"} sets up the first one as an admin.
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const name = String(b.name ?? '').trim();
    const password = String(b.password ?? '');
    if (needsSetup()) {
      if (String(b.confirm ?? '') !== password) throw new Error('The two passwords do not match.');
      const user = createUser(name, 'admin', password, typeof b.display === 'string' ? b.display : undefined);
      const { token, maxAgeSeconds } = createSession(user.name);
      return sessionCookie(NextResponse.json({ ok: true, name: user.name, displayName: shownName(user), role: user.role }), token, maxAgeSeconds);
    }
    const { user, token, maxAgeSeconds } = signIn(name, password);
    return sessionCookie(NextResponse.json({ ok: true, name: user.name, displayName: user.displayName, role: user.role }), token, maxAgeSeconds);
  } catch (e) {
    return fail(e, 401);
  }
}

// The login page asks whether accounts exist yet, and whether you are already signed in
export async function GET(req: NextRequest) {
  const user = requireUser(req);
  if (isResponse(user)) {
    return NextResponse.json({ needsSetup: needsSetup() });
  }
  return NextResponse.json({ needsSetup: false, name: user.name, displayName: user.displayName, role: user.role });
}

// Sign out
export async function DELETE(req: NextRequest) {
  try {
    destroySession(req);
    return clearSessionCookie(NextResponse.json({ ok: true }));
  } catch (e) {
    return fail(e);
  }
}