import { NextRequest, NextResponse } from 'next/server';
import { fail, requireUser, isResponse, sessionCookie, clearSessionCookie } from '@/lib/api';
import { signIn, needsSetup, createUser, createSession, destroySession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Sign in. With no accounts yet, {"name","passcode","confirm"} sets up the first one as an admin.
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const name = String(b.name ?? '').trim();
    const passcode = String(b.passcode ?? '');
    if (needsSetup()) {
      if (String(b.confirm ?? '') !== passcode) throw new Error('The two passcodes do not match.');
      const user = createUser(name, 'admin', passcode);
      const { token, maxAgeSeconds } = createSession(user.name);
      return sessionCookie(NextResponse.json({ ok: true, name: user.name, role: user.role }), token, maxAgeSeconds);
    }
    const { user, token, maxAgeSeconds } = signIn(name, passcode);
    return sessionCookie(NextResponse.json({ ok: true, name: user.name, role: user.role }), token, maxAgeSeconds);
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
  return NextResponse.json({ needsSetup: false, name: user.name, role: user.role });
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