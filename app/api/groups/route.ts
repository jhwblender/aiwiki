import { NextRequest, NextResponse } from 'next/server';
import { createGroup, deleteGroup, listGroups, updateGroup } from '@/lib/access';
import { listUsers } from '@/lib/auth';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const parentOf = (v: unknown) => (v === null || v === '' || v === undefined ? null : Number(v));

// Groups on the Settings page, for admins
export async function GET(req: NextRequest) {
  const admin = requireUser(req, 'admin');
  if (isResponse(admin)) return admin;
  return NextResponse.json({ groups: listGroups(), people: listUsers().map((u) => ({ name: u.name, display: u.display })) });
}

export async function POST(req: NextRequest) {
  try {
    const admin = requireUser(req, 'admin');
    if (isResponse(admin)) return admin;
    const b = await req.json();
    return NextResponse.json({ id: createGroup(String(b.name ?? ''), parentOf(b.parentId)) });
  } catch (e) {
    return fail(e);
  }
}

// Rename a group, put it under another one, or set who is in it
export async function PATCH(req: NextRequest) {
  try {
    const admin = requireUser(req, 'admin');
    if (isResponse(admin)) return admin;
    const b = await req.json();
    updateGroup(Number(b.id), {
      name: typeof b.name === 'string' ? b.name : undefined,
      parentId: 'parentId' in b ? parentOf(b.parentId) : undefined,
      members: Array.isArray(b.members) ? b.members.map(String) : undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const admin = requireUser(req, 'admin');
    if (isResponse(admin)) return admin;
    deleteGroup(Number(req.nextUrl.searchParams.get('id')));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
