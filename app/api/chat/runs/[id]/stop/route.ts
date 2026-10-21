import { NextRequest, NextResponse } from 'next/server';
import { stopRun } from '@/lib/runs';

export const runtime = 'nodejs';

// Stop a chat run after its current step; suggestions already made stay for review
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return NextResponse.json({ stopped: stopRun(id) });
}
