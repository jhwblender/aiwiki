import { NextRequest, NextResponse } from 'next/server';
import { fail, requireUser, isResponse } from '@/lib/api';
import { listUsers, createUser, deleteUser, setRole, setDisplay, resetPassword, type Role } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// People on the Settings page. Only admins get past this point, including the password hashes'
// absence: no hashes ever leave the server.
export async function GET(req: NextRequest) {
  const user = requireUser(req, 'admin');
  if (isResponse(user)) return user;
  return NextResponse.json(listUsers());
}

// Add a person; the admin picks their starting password, which they can change in the menu
export async function POST(req: NextRequest) {
  try {
    const user = requireUser(req, 'admin');
    if (isResponse(user)) return user;
    const b = await req.json();
    const created = createUser(String(b.name ?? ''), String(b.role ?? 'viewer') as Role, String(b.password ?? ''), typeof b.display === 'string' ? b.display : undefined);
    return NextResponse.json({ name: created.name, display: created.display_name, role: created.role, created: created.created_at });
  } catch (e) {
    return fail(e);
  }
}

// Change a role or password
export async function PATCH(req: NextRequest) {
  try {
    const user = requireUser(req, 'admin');
    if (isResponse(user)) return user;
    const b = await req.json();
    const name = String(b.name ?? '');
    if (typeof b.role === 'string') setRole(name, b.role as Role);
    if (typeof b.display === 'string') setDisplay(name, b.display);
    if (typeof b.password === 'string') resetPassword(name, b.password);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

// Remove a person; their sessions die with the account
export async function DELETE(req: NextRequest) {
  try {
    const user = requireUser(req, 'admin');
    if (isResponse(user)) return user;
    deleteUser(String(req.nextUrl.searchParams.get('name') ?? ''), user.name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}