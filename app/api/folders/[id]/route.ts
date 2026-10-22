import { NextRequest, NextResponse } from 'next/server';
import { changeFolderPath, removeFolder, setEnabled, setVisibility } from '@/lib/watcher';
import { fail } from '@/lib/api';

export const runtime = 'nodejs';

// Pause or resume a watched folder, or point it at its new location
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const b = await req.json();
    if (typeof b.path === 'string') await changeFolderPath(Number(id), b.path);
    if (typeof b.enabled === 'boolean') setEnabled(Number(id), b.enabled);
    if (b.visibility === 'wiki' || b.visibility === 'personal') {
      return NextResponse.json({ ok: true, queued: await setVisibility(Number(id), b.visibility, !!b.fileExisting) });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

// Stop watching; nothing already in the wiki changes
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    removeFolder(Number(id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
