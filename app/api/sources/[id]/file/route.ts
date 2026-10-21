import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readStored } from '@/lib/files';
import { fail, fileResponse } from '@/lib/api';

export const runtime = 'nodejs';

// The original file a suggestion came from, opened from its source chip
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const s = db().prepare("SELECT filename, stored_path FROM sources WHERE id = ? AND kind = 'file'").get(Number(id)) as
      | { filename: string; stored_path: string | null }
      | undefined;
    if (!s?.stored_path) return NextResponse.json({ error: 'This source has no stored file' }, { status: 404 });
    const f = db().prepare('SELECT mime FROM files WHERE stored_path = ? LIMIT 1').get(s.stored_path) as { mime: string } | undefined;
    return fileResponse({ filename: s.filename, mime: f?.mime ?? 'application/octet-stream' }, await readStored({ storedPath: s.stored_path }));
  } catch (e) {
    return fail(e, 404);
  }
}
