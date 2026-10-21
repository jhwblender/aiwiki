import { NextRequest, NextResponse } from 'next/server';
import { removeFolder, setEnabled } from '@/lib/watcher';
import { fail } from '@/lib/api';

export const runtime = 'nodejs';

// Pause or resume a watched folder
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const b = await req.json();
    setEnabled(Number(id), !!b.enabled);
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
