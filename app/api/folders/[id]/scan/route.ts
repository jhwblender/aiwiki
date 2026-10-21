import { NextRequest, NextResponse } from 'next/server';
import { scanFolder } from '@/lib/watcher';
import { fail } from '@/lib/api';

export const runtime = 'nodejs';

// Check a folder now instead of waiting for the next scan
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return NextResponse.json({ queued: await scanFolder(Number(id)) });
  } catch (e) {
    return fail(e);
  }
}
