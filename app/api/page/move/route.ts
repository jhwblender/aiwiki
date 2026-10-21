import { NextRequest, NextResponse } from 'next/server';
import { normalizePath } from '@/lib/wiki';
import { movePageWithRecords } from '@/lib/proposals';
import { fail, userFrom } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A person moving or renaming a page publishes immediately, like any human edit.
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const from = normalizePath(String(b.from ?? ''));
    const to = normalizePath(String(b.to ?? ''));
    const user = userFrom(b.user);
    const moves = await movePageWithRecords(from, to, user, `Move ${from} to ${to}`);
    return NextResponse.json({ path: to, moved: moves.length });
  } catch (e) {
    return fail(e);
  }
}
