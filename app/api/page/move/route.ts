import { NextRequest, NextResponse } from 'next/server';
import { normalizePath, readPage, titleFor, writePage } from '@/lib/wiki';
import { movePageWithRecords } from '@/lib/proposals';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A person moving or renaming a page publishes immediately, like any human edit. With a title, the
// page's heading changes to it as well.
export async function POST(req: NextRequest) {
  try {
    const editor = requireUser(req, 'editor');
    if (isResponse(editor)) return editor;
    const b = await req.json();
    const from = normalizePath(String(b.from ?? ''));
    const to = normalizePath(String(b.to ?? ''));
    const user = editor.name;
    const moves = to === from ? [] : await movePageWithRecords(from, to, user, `Move ${from} to ${to}`);
    const title = typeof b.title === 'string' ? b.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    const md = title ? await readPage(to) : null;
    if (md !== null && titleFor(md, to) !== title) {
      const next = /^#\s.*$/m.test(md) ? md.replace(/^#\s.*$/m, () => `# ${title}`) : `# ${title}\n\n${md}`;
      await writePage(to, next, user, `Rename ${to} to ${title}`);
    }
    return NextResponse.json({ path: to, moved: moves.length });
  } catch (e) {
    return fail(e);
  }
}
