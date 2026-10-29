import { NextRequest, NextResponse } from 'next/server';
import { approvalHistory, undoApproval } from '@/lib/history';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The journal of approvals: pages created, removed and moved for the whole wiki, or everything
// approved on one page with ?page=. POST undoes one approval, guarded so anything done since
// stays as it is.
export async function GET(req: NextRequest) {
  const viewer = requireUser(req);
  if (isResponse(viewer)) return viewer;
  const page = req.nextUrl.searchParams.get('page') || undefined;
  return NextResponse.json(await approvalHistory(page));
}

export async function POST(req: NextRequest) {
  try {
    const editor = requireUser(req, 'editor');
    if (isResponse(editor)) return editor;
    const b = await req.json();
    if (b.action !== 'undo' || typeof b.commit !== 'string') throw new Error('Unknown action');
    await undoApproval(b.commit, editor.displayName);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}