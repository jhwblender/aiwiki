import { NextRequest, NextResponse } from 'next/server';
import { approvalHistory, pagesOfApproval, undoApproval } from '@/lib/history';
import { accessFor } from '@/lib/access';
import { opPages, proposalPage, rejectedItems, unReject } from '@/lib/proposals';
import { denied, fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The journal of approvals: pages created, removed and moved for the whole wiki, or everything
// approved on one page with ?page=. The rejected suggestions read from the decision records ride
// along as `rejected`, since a decision not to publish shows nowhere in the wiki itself. POST
// undoes an approval or takes a rejection back, guarded so nothing newer is lost.
export async function GET(req: NextRequest) {
  const viewer = requireUser(req);
  if (isResponse(viewer)) return viewer;
  const page = req.nextUrl.searchParams.get('page') || undefined;
  const { visible } = accessFor(viewer);
  if (page && !visible(page)) return NextResponse.json({ entries: [], more: false, rejected: [] });
  const journal = await approvalHistory(page);
  // An approval that touched a page this person cannot read shows only the parts they can
  const entries = journal.entries
    .map((e) => ({ ...e, actions: e.actions.filter((a) => visible(a.path) && (!a.newPath || visible(a.newPath))) }))
    .filter((e) => e.actions.length);
  const rejected = (await rejectedItems(page)).filter((r) => visible(r.pagePath) && (!r.newPath || visible(r.newPath)));
  return NextResponse.json({ ...journal, entries, rejected });
}

export async function POST(req: NextRequest) {
  try {
    const editor = requireUser(req);
    if (isResponse(editor)) return editor;
    const b = await req.json();
    const access = accessFor(editor);
    const touched = b.action === 'undo' ? await pagesOfApproval(String(b.commit)) : b.kind === 'op' ? opPages(Number(b.id)) : [proposalPage(Number(b.id)) ?? ''].filter(Boolean);
    if (!touched.length && editor.role === 'viewer') return NextResponse.json({ error: 'You do not have permission to do that.' }, { status: 403 });
    for (const p of touched) {
      const no = denied(access, p, 'approve');
      if (no) return no;
    }
    if (b.action === 'undo' && typeof b.commit === 'string') {
      await undoApproval(b.commit, editor.displayName);
      return NextResponse.json({ ok: true });
    }
    if (b.action === 'unreject' && (b.kind === 'op' || b.kind === 'proposal') && Number.isInteger(Number(b.id))) {
      await unReject(b.kind, Number(b.id), editor.displayName);
      return NextResponse.json({ ok: true });
    }
    throw new Error('Unknown action');
  } catch (e) {
    return fail(e);
  }
}
