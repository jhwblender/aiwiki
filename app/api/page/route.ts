import { NextRequest, NextResponse } from 'next/server';
import { deletePage, normalizePath, readPage, subPages, titleFor, writePage } from '@/lib/wiki';
import { pendingForPage, pendingOpsForPage, sourcesForPage } from '@/lib/proposals';
import { fail, requireUser, isResponse } from '@/lib/api';
import type { PageData } from '@/lib/types';
import { summaryProblem } from '@/lib/summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const viewer = requireUser(req);
    if (isResponse(viewer)) return viewer;
    const p = normalizePath(req.nextUrl.searchParams.get('path') || '');
    const content = await readPage(p);
    const pending = await pendingForPage(p);
    // A page that only exists as a suggestion takes its title from the suggested text
    const suggested = content === null ? pending.find((s) => s.isNew) : undefined;
    const draft = suggested?.segments.flatMap((s) => (s.type === 'change' ? s.added : [])).join('\n\n');
    const data: PageData = {
      path: p,
      exists: content !== null,
      title: titleFor(content ?? draft ?? '', p),
      content: content ?? '',
      pending,
      ops: await pendingOpsForPage(p),
      sources: sourcesForPage(p),
      children: await subPages(p),
    };
    return NextResponse.json(data);
  } catch (e) {
    return fail(e);
  }
}

// Direct human edit: published immediately, committed to git under the editor's name.
export async function PUT(req: NextRequest) {
  try {
    const user = requireUser(req, 'editor');
    if (isResponse(user)) return user;
    const body = await req.json();
    const p = normalizePath(String(body.path || ''));
    const content = String(body.content ?? '');
    const problem = summaryProblem(await readPage(p), content);
    if (problem) throw new Error(problem);
    await writePage(p, content, user.displayName, `Edit ${p}`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = requireUser(req, 'editor');
    if (isResponse(user)) return user;
    const p = normalizePath(req.nextUrl.searchParams.get('path') || '');
    await deletePage(p, user.displayName);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
