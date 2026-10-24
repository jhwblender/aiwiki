import { NextRequest, NextResponse } from 'next/server';
import { scanFolder } from '@/lib/watcher';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';

// Check a folder now instead of waiting for the next scan
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const editor = requireUser(req, 'editor');
    if (isResponse(editor)) return editor;
    const { id } = await ctx.params;
    return NextResponse.json({ queued: await scanFolder(Number(id)) });
  } catch (e) {
    return fail(e);
  }
}
