import { NextRequest, NextResponse } from 'next/server';
import { decideOp, opPages } from '@/lib/proposals';
import { accessFor } from '@/lib/access';
import { denied, fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';

// Approve or reject a suggested move or removal of a page
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = requireUser(req);
    if (isResponse(user)) return user;
    const { id } = await ctx.params;
    const access = accessFor(user);
    for (const p of opPages(Number(id))) {
      const no = denied(access, p, 'approve');
      if (no) return no;
    }
    const b = await req.json();
    if (b.action !== 'approve' && b.action !== 'reject') throw new Error('Invalid action');
    return NextResponse.json(await decideOp(Number(id), b.action, user.displayName));
  } catch (e) {
    return fail(e);
  }
}
