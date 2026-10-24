import { NextRequest, NextResponse } from 'next/server';
import { fail, requireUser, isResponse } from '@/lib/api';
import { changeOwnPasscode } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Who the browser is signed in as; the UI uses this instead of a remembered name
export async function GET(req: NextRequest) {
  const user = requireUser(req);
  if (isResponse(user)) return user;
  return NextResponse.json({ name: user.name, role: user.role });
}

// A person changes their own passcode
export async function POST(req: NextRequest) {
  try {
    const user = requireUser(req);
    if (isResponse(user)) return user;
    const b = await req.json();
    changeOwnPasscode(user.name, String(b.current ?? ''), String(b.next ?? ''));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}