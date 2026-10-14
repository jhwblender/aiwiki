import { NextRequest, NextResponse } from 'next/server';
import { deletePage, normalizePath, readPage, titleFor, writePage } from '@/lib/wiki';
import { pendingForPage, sourcesForPage } from '@/lib/proposals';
import { fail, userFrom } from '@/lib/api';
import type { PageData } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const p = normalizePath(req.nextUrl.searchParams.get('path') || '');
    const content = await readPage(p);
    const data: PageData = {
      path: p,
      exists: content !== null,
      title: titleFor(content ?? '', p),
      content: content ?? '',
      pending: await pendingForPage(p),
      sources: sourcesForPage(p),
    };
    return NextResponse.json(data);
  } catch (e) {
    return fail(e);
  }
}

// Direct human edit: published immediately, committed to git under the editor's name.
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const p = normalizePath(String(body.path || ''));
    const user = userFrom(body.user);
    await writePage(p, String(body.content ?? ''), user, `Edit ${p}`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const p = normalizePath(req.nextUrl.searchParams.get('path') || '');
    await deletePage(p, userFrom(req.nextUrl.searchParams.get('user')));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
