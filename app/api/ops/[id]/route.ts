import { NextRequest, NextResponse } from 'next/server';
import { decideOp } from '@/lib/proposals';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';

// Approve or reject a suggested move or removal of a page
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = requireUser(req, 'editor');
    if (isResponse(user)) return user;
    const { id } = await ctx.params;
    const b = await req.json();
    if (b.action !== 'approve' && b.action !== 'reject') throw new Error('Invalid action');
    return NextResponse.json(await decideOp(Number(id), b.action, user.name));
  } catch (e) {
    return fail(e);
  }
}
