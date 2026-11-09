import { NextRequest, NextResponse } from 'next/server';
import { deletePage, normalizePath, readPage, subPages, titleFor, writePage } from '@/lib/wiki';
import { ownPageSuggestion, pendingForPage, pendingOpsForPage, sourcesForPage, suggestEdit } from '@/lib/proposals';
import { accessFor } from '@/lib/access';
import { denied, fail, requireUser, isResponse } from '@/lib/api';
import type { PageData } from '@/lib/types';
import { summaryProblem } from '@/lib/summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const viewer = requireUser(req);
    if (isResponse(viewer)) return viewer;
    const p = normalizePath(req.nextUrl.searchParams.get('path') || '');
    const access = accessFor(viewer);
    const no = denied(access, p, 'read');
    if (no) return no;
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
      children: (await subPages(p)).filter((c) => access.visible(c.path)),
      access: { level: access.level(p), limitedBy: access.ruleFrom(p) },
      mySuggestion: access.level(p) === 'suggest' ? await ownPageSuggestion(viewer.displayName, p) : null,
    };
    return NextResponse.json(data);
  } catch (e) {
    return fail(e);
  }
}

// Direct human edit: published immediately, committed to git under the editor's name. At the
// Can suggest level the same save waits on the page for someone who can approve it.
export async function PUT(req: NextRequest) {
  try {
    const user = requireUser(req);
    if (isResponse(user)) return user;
    const body = await req.json();
    const p = normalizePath(String(body.path || ''));
    const access = accessFor(user);
    const no = denied(access, p, 'suggest');
    if (no) return no;
    const content = String(body.content ?? '');
    const problem = summaryProblem(await readPage(p), content);
    if (problem) throw new Error(problem);
    if (!access.can(p, 'edit')) return NextResponse.json({ ok: true, suggested: await suggestEdit(p, content, user.displayName) });
    await writePage(p, content, user.displayName, `Edit ${p}`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = requireUser(req);
    if (isResponse(user)) return user;
    const p = normalizePath(req.nextUrl.searchParams.get('path') || '');
    const no = denied(accessFor(user), p, 'edit');
    if (no) return no;
    await deletePage(p, user.displayName);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
