import { NextRequest, NextResponse } from 'next/server';
import { browse, shortcuts } from '@/lib/folderbrowse';
import { fail } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Folders on the wiki server, for picking one to watch. Without a path: places to start from.
export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams.get('path');
    if (!p) return NextResponse.json({ shortcuts: await shortcuts() });
    return NextResponse.json(await browse(p));
  } catch (e) {
    return fail(e);
  }
}
