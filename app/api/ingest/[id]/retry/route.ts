import { NextRequest, NextResponse } from 'next/server';
import { retryJob } from '@/lib/queue';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const editor = requireUser(req, 'editor');
    if (isResponse(editor)) return editor;
    const { id } = await ctx.params;
    retryJob(Number(id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
