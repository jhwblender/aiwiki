import { NextRequest, NextResponse } from 'next/server';
import { getFile, readStored } from '@/lib/files';
import { fail, fileResponse } from '@/lib/api';

export const runtime = 'nodejs';

// The original file, for attachment links and for photos shown on pages
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const f = getFile(Number(id));
    if (!f) return NextResponse.json({ error: 'File not found' }, { status: 404 });
    return fileResponse(f, await readStored(f));
  } catch (e) {
    return fail(e, 404);
  }
}
