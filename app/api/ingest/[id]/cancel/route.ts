import { NextRequest, NextResponse } from 'next/server';
import { cancelJob } from '@/lib/queue';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';

// Cancel a waiting job, or stop the running one after its current step
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const editor = requireUser(req, 'editor');
    if (isResponse(editor)) return editor;
    const { id } = await ctx.params;
    cancelJob(Number(id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
