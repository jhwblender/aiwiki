import { NextRequest, NextResponse } from 'next/server';
import { getFile } from '@/lib/files';
import { dropIdentity } from '@/lib/ingest';
import { enqueue, recentJobs } from '@/lib/queue';
import { fail, userFrom } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Recent background filing, newest first
export async function GET() {
  return NextResponse.json(recentJobs());
}

// File uploaded files in the background, one job per file
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const ids: number[] = (Array.isArray(b.fileIds) ? b.fileIds : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0);
    if (!ids.length) throw new Error('No files to file.');
    const user = userFrom(b.user);
    const jobs = ids.map((id) => {
      const f = getFile(id);
      if (!f) throw new Error(`File ${id} not found.`);
      return enqueue({
        fileId: f.id,
        identity: dropIdentity(f.filename),
        user,
        note: typeof b.note === 'string' ? b.note : undefined,
        currentPath: typeof b.currentPath === 'string' ? b.currentPath : undefined,
        provider: typeof b.provider === 'string' ? b.provider : undefined,
      });
    });
    return NextResponse.json({ jobs });
  } catch (e) {
    return fail(e);
  }
}
