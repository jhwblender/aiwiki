import { NextRequest, NextResponse } from 'next/server';
import { runStream } from '@/lib/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

// Reconnect to a chat run: everything so far, then live progress until it finishes
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return runStream(id) ?? NextResponse.json({ error: 'That request is no longer known. The wiki may have restarted.' }, { status: 404 });
}
