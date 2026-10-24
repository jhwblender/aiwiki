import { NextRequest, NextResponse } from 'next/server';
import { getFile, readStored } from '@/lib/files';
import { fail, fileResponse, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';

// The original file, for attachment links and for photos shown on pages
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const viewer = requireUser(req);
    if (isResponse(viewer)) return viewer;
    const { id } = await ctx.params;
    const f = getFile(Number(id));
    if (!f) return NextResponse.json({ error: 'File not found' }, { status: 404 });
    return fileResponse(f, await readStored(f));
  } catch (e) {
    return fail(e, 404);
  }
}
