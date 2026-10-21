import { NextRequest, NextResponse } from 'next/server';
import { decideOp } from '@/lib/proposals';
import { fail, userFrom } from '@/lib/api';

export const runtime = 'nodejs';

// Approve or reject a suggested move or removal of a page
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const b = await req.json();
    if (b.action !== 'approve' && b.action !== 'reject') throw new Error('Invalid action');
    return NextResponse.json(await decideOp(Number(id), b.action, userFrom(b.user)));
  } catch (e) {
    return fail(e);
  }
}
