import { NextRequest, NextResponse } from 'next/server';
import { retryJob } from '@/lib/queue';
import { fail } from '@/lib/api';

export const runtime = 'nodejs';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    retryJob(Number(id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
