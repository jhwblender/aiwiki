import { NextRequest, NextResponse } from 'next/server';
import { cancelWaiting, retryFailed, retryNow, setPaused } from '@/lib/queue';
import { fail } from '@/lib/api';

export const runtime = 'nodejs';

// Pause or resume background filing, cancel what is waiting, retry what failed, or try the model again now
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    switch (b.action) {
      case 'pause':
        setPaused(true);
        return NextResponse.json({ ok: true });
      case 'resume':
        setPaused(false);
        return NextResponse.json({ ok: true });
      case 'retry-failed':
        return NextResponse.json({ count: retryFailed() });
      case 'retry-now':
        retryNow();
        return NextResponse.json({ ok: true });
      case 'cancel-waiting':
        // folder: a label, null for files not from a folder, absent for everything waiting
        return NextResponse.json({ count: cancelWaiting('folder' in b ? (b.folder === null ? null : String(b.folder)) : undefined) });
      default:
        throw new Error('Unknown action');
    }
  } catch (e) {
    return fail(e);
  }
}
