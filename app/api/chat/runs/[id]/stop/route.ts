import { NextRequest, NextResponse } from 'next/server';
import { stopRun } from '@/lib/runs';
import { requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';

// Stop a chat run after its current step; suggestions already made stay for review
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = requireUser(req);
  if (isResponse(user)) return user;
  const { id } = await ctx.params;
  return NextResponse.json({ stopped: stopRun(id) });
}
