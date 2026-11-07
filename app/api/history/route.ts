import { NextRequest, NextResponse } from 'next/server';
import { approvalHistory, undoApproval } from '@/lib/history';
import { rejectedItems, unReject } from '@/lib/proposals';
import { fail, requireUser, isResponse } from '@/lib/api';

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
  return NextResponse.json({ ...(await approvalHistory(page)), rejected: await rejectedItems(page) });
}

export async function POST(req: NextRequest) {
  try {
    const editor = requireUser(req, 'editor');
    if (isResponse(editor)) return editor;
    const b = await req.json();
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
