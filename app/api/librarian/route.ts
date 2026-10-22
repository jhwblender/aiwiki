import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { DEFAULT_LIMIT, listSections } from '@/lib/librarian';
import { enqueueTidy } from '@/lib/queue';
import { normalizePath, readPage } from '@/lib/wiki';
import { fail, userFrom } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Sections that can be tidied, with any tidy run already waiting or running for each
export async function GET() {
  const active = db()
    .prepare("SELECT doc_key, status FROM ingest_jobs WHERE mode = 'tidy' AND status IN ('queued', 'working')")
    .all() as { doc_key: string; status: string }[];
  const busy = new Map(active.map((r) => [r.doc_key.slice('tidy:'.length), r.status]));
  const sections = (await listSections()).map((s) => ({ ...s, run: busy.get(s.section) ?? null }));
  return NextResponse.json({ sections, limit: DEFAULT_LIMIT });
}

// Start a tidy run over one section; it runs in the background queue
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const section = normalizePath(String(b.section ?? ''));
    if (section === 'index') throw new Error('The home page is not a section.');
    const has = (await readPage(section)) !== null || (await listSections()).some((s) => s.section === section.split('/')[0]);
    if (!has) throw new Error(`There is no section "${section}".`);
    const job = enqueueTidy({
      section,
      user: userFrom(b.user),
      provider: typeof b.provider === 'string' && b.provider ? b.provider : undefined,
      limit: b.limit === undefined ? undefined : Number(b.limit),
    });
    return NextResponse.json({ job });
  } catch (e) {
    return fail(e);
  }
}
