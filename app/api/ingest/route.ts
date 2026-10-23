import { NextRequest, NextResponse } from 'next/server';
import { getFile } from '@/lib/files';
import { dropIdentity } from '@/lib/ingest';
import { enqueue, listJobs, queueState, type JobStatus } from '@/lib/queue';
import { fail, userFrom } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES = ['queued', 'working', 'done', 'kept', 'skipped', 'failed', 'cancelled'] as const;

// The queue's state (paused, waiting for the model, the running job and its steps, counts) and a
// list of jobs: the running one first, then newest first, or only one status with ?status=
export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get('status') as JobStatus | null;
  return NextResponse.json({ ...queueState(), jobs: listJobs(status && STATUSES.includes(status) ? status : undefined) });
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
