import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { librarianSettings, listSections, MAX_LIMIT, saveLibrarianSettings, WHOLE } from '@/lib/librarian';
import { checkLibrarian } from '@/lib/librarianAuto';
import { enqueueTidy } from '@/lib/queue';
import { normalizePath, readPage } from '@/lib/wiki';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Sections that can be tidied, with any tidy run already waiting or running for each (and for the
// whole wiki), and the librarian's settings
export async function GET(req: NextRequest) {
  const viewer = requireUser(req);
  if (isResponse(viewer)) return viewer;
  const active = db()
    .prepare("SELECT doc_key, status FROM ingest_jobs WHERE mode = 'tidy' AND status IN ('queued', 'working')")
    .all() as { doc_key: string; status: string }[];
  const busy = new Map(active.map((r) => [r.doc_key.slice('tidy:'.length), r.status]));
  const sections = (await listSections()).map((s) => ({ ...s, run: busy.get(s.section) ?? null }));
  return NextResponse.json({ sections, whole: { run: busy.get(WHOLE) ?? null }, settings: librarianSettings(), maxLimit: MAX_LIMIT });
}

// Start a tidy run over one section, or the whole wiki with section "*"; it runs in the background
// queue. { action: "check" } queues the librarian's next due run of its own now.
export async function POST(req: NextRequest) {
  try {
    const editor = requireUser(req, 'editor');
    if (isResponse(editor)) return editor;
    const b = await req.json();
    if (b.action === 'check') return NextResponse.json({ started: await checkLibrarian() });
    let section = WHOLE;
    if (b.section !== WHOLE) {
      section = normalizePath(String(b.section ?? ''));
      if (section === 'index') throw new Error('The home page is not a section; tidy the whole wiki instead.');
      const has = (await readPage(section)) !== null || (await listSections()).some((s) => s.section === section.split('/')[0]);
      if (!has) throw new Error(`There is no section "${section}".`);
    }
    const job = enqueueTidy({
      section,
      user: editor.name,
      provider: typeof b.provider === 'string' && b.provider ? b.provider : undefined,
      limit: b.limit === undefined ? undefined : Number(b.limit),
    });
    return NextResponse.json({ job });
  } catch (e) {
    return fail(e);
  }
}

// Change the limit per run, or turn the librarian's own runs on or off
export async function PUT(req: NextRequest) {
  try {
    const admin = requireUser(req, 'admin');
    if (isResponse(admin)) return admin;
    const b = await req.json();
    return NextResponse.json(
      saveLibrarianSettings({ limit: b.limit === undefined ? undefined : Number(b.limit), auto: typeof b.auto === 'boolean' ? b.auto : undefined }),
    );
  } catch (e) {
    return fail(e);
  }
}
