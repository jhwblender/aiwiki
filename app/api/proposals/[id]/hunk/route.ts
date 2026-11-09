import { NextRequest, NextResponse } from 'next/server';
import { decideHunk, proposalPage } from '@/lib/proposals';
import { accessFor } from '@/lib/access';
import { denied, fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = requireUser(req);
    if (isResponse(user)) return user;
    const { id } = await ctx.params;
    const page = proposalPage(Number(id));
    const no = page === null ? null : denied(accessFor(user), page, 'approve');
    if (no) return no;
    const b = await req.json();
    if (b.action !== 'approve' && b.action !== 'reject') throw new Error('Invalid action');
    await decideHunk(Number(id), Number(b.hunk), String(b.fp), b.action, user.displayName);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
