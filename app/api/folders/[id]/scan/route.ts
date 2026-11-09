import { NextRequest, NextResponse } from 'next/server';
import { folderLabel, scanFolder } from '@/lib/watcher';
import { accessFor } from '@/lib/access';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';

// Check a folder now instead of waiting for the next scan
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const editor = requireUser(req, 'editor');
    if (isResponse(editor)) return editor;
    const { id } = await ctx.params;
    if (!accessFor(editor).folderAllowed(folderLabel(Number(id)))) return NextResponse.json({ error: 'Folder not found' }, { status: 404 });
    return NextResponse.json({ queued: await scanFolder(Number(id)) });
  } catch (e) {
    return fail(e);
  }
}
