import { NextRequest, NextResponse } from 'next/server';
import { stopFolderJobs } from '@/lib/queue';
import { changeFolderPath, folderLabel, removeFolder, scanFolder, setEnabled, setVisibility } from '@/lib/watcher';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';

// Pause or resume a watched folder, or point it at its new location
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const editor = requireUser(req, 'editor');
    if (isResponse(editor)) return editor;
    const { id } = await ctx.params;
    const b = await req.json();
    if (typeof b.path === 'string') {
      const moved = await changeFolderPath(Number(id), b.path);
      if (typeof b.enabled === 'boolean') setEnabled(Number(id), b.enabled);
      if (b.visibility === 'wiki' || b.visibility === 'personal') {
        const queued = await setVisibility(Number(id), b.visibility, !!b.fileExisting);
        void scanFolder(Number(id)).catch(() => {});
        return NextResponse.json({ ok: true, label: moved.label, queued });
      }
      // Bring the new location in (and its subfolders onto the plan view) without waiting
      // for the next regular scan
      void scanFolder(Number(id)).catch(() => {});
      return NextResponse.json({ ok: true, label: moved.label });
    }
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
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const editor = requireUser(req, 'editor');
    if (isResponse(editor)) return editor;
    const { id } = await ctx.params;
    const label = folderLabel(Number(id));
    const cancelled = label ? stopFolderJobs(label) : 0;
    removeFolder(Number(id));
    return NextResponse.json({ ok: true, cancelled });
  } catch (e) {
    return fail(e);
  }
}
