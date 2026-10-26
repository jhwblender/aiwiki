import { NextRequest, NextResponse } from 'next/server';
import { beginChat, cancelWaiting, clearFinished, retryFailed, retryNow, retryStopped, setPaused } from '@/lib/queue';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';

// Pause or resume background filing, cancel what is waiting, retry what failed or was cancelled,
// clear what is finished, or try the model again now
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
      case 'resume':
        setPaused(false);
        return NextResponse.json({ ok: true });
      case 'retry-failed':
        return NextResponse.json({ count: retryFailed() });
      case 'retry-cancelled':
        return NextResponse.json({ count: retryStopped('cancelled', folder) });
      case 'clear-finished':
        return NextResponse.json({ count: clearFinished(folder) });
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
