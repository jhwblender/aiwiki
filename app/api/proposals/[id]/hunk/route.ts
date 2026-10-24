import { NextRequest, NextResponse } from 'next/server';
import { decideHunk } from '@/lib/proposals';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = requireUser(req, 'editor');
    if (isResponse(user)) return user;
    const { id } = await ctx.params;
    const b = await req.json();
    if (b.action !== 'approve' && b.action !== 'reject') throw new Error('Invalid action');
    await decideHunk(Number(id), Number(b.hunk), String(b.fp), b.action, user.displayName);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
