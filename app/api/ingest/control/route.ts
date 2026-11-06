import { NextRequest, NextResponse } from 'next/server';
import { beginChat, cancelWaiting, chatsRunning, clearCancelled, clearFinished, retryFailed, retryNow, retryStopped, setPaused } from '@/lib/queue';
import { unloadLocalModel } from '@/lib/ai/local';
import { localModelSettings } from '@/lib/settings';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';

// Pause or resume background filing, cancel what is waiting, retry what failed or was cancelled,
// clear what is finished or what was cancelled, or try the model again now
export async function POST(req: NextRequest) {
  try {
    const editor = requireUser(req, 'editor');
    if (isResponse(editor)) return editor;
    const b = await req.json();
    const folder = 'folder' in b ? (b.folder === null ? null : String(b.folder)) : undefined;
    switch (b.action) {
      case 'pause':
        setPaused(true);
        return NextResponse.json({ ok: true });
      case 'stop-ai':
        // The same full stop as pausing, plus a best-effort ask to the local model server to
        // unload its model now, so the machine really is freed. Not while a chat is generating:
        // unloading under a running answer can wedge the model server's scheduler
        setPaused(true);
        if (chatsRunning()) return NextResponse.json({ ok: true, freed: false, busy: true });
        return NextResponse.json({ ok: true, freed: await unloadLocalModel(localModelSettings()) });
      case 'resume':
        setPaused(false);
        return NextResponse.json({ ok: true });
      case 'retry-failed':
        return NextResponse.json({ count: retryFailed() });
      case 'retry-cancelled':
        return NextResponse.json({ count: retryStopped('cancelled', folder) });
      case 'clear-finished':
        return NextResponse.json({ count: clearFinished(folder) });
      case 'clear-cancelled':
        return NextResponse.json({ count: clearCancelled(folder) });
      case 'retry-now':
        retryNow();
        return NextResponse.json({ ok: true });
      case 'cancel-waiting':
        // folder: a label, null for files not from a folder, absent for everything waiting
        return NextResponse.json({ count: cancelWaiting(folder) });
      default:
        throw new Error('Unknown action');
    }
  } catch (e) {
    return fail(e);
  }
}
