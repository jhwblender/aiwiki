import { NextRequest, NextResponse } from 'next/server';
import { buildStructure, withSummary } from '@/lib/structure';
import { pendingCounts } from '@/lib/proposals';
import { normalizePath, readPage, writePage } from '@/lib/wiki';
import { fail, userFrom } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The wiki's structure, generated from the pages, with how many suggestions wait on each page
export async function GET() {
  const pending = Object.fromEntries([...pendingCounts().entries()].map(([p, v]) => [p, v.count]));
  return NextResponse.json({ ...(await buildStructure()), pending });
}

// A person edits one summary: published at once under their name, like any human edit. A folder
// of pages with no page of its own gets a page holding just its title and summary.
export async function PUT(req: NextRequest) {
  try {
    const b = await req.json();
    const p = normalizePath(String(b.path ?? ''));
    const user = userFrom(b.user);
    const next = withSummary(await readPage(p), String(b.summary ?? ''), p);
    await writePage(p, next, user, `Edit the summary of ${p}`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
