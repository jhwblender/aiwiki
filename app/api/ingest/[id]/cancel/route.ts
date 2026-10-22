import { NextRequest, NextResponse } from 'next/server';
import { cancelJob } from '@/lib/queue';
import { fail } from '@/lib/api';

export const runtime = 'nodejs';

// Cancel a waiting job, or stop the running one after its current step
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    cancelJob(Number(id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
