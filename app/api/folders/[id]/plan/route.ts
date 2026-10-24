import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { planTree, RULES, setRule, type Rule } from '@/lib/filingPlan';
import { enqueuePlan } from '@/lib/queue';
import { refile } from '@/lib/watcher';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function folderOf(id: string) {
  const f = db().prepare('SELECT id, label, user FROM watched_folders WHERE id = ?').get(Number(id)) as { id: number; label: string; user: string } | undefined;
  if (!f) throw new Error('Folder not found.');
  return f;
}

// The folder's tree with each folder's rule and how its files were handled
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const viewer = requireUser(req);
    if (isResponse(viewer)) return viewer;
    const f = folderOf((await ctx.params).id);
    const planning = !!db().prepare("SELECT 1 FROM ingest_jobs WHERE doc_key = ? AND status IN ('queued', 'working')").get(`plan:${f.label}`);
    return NextResponse.json({ label: f.label, tree: planTree(f.id, f.label), planning });
  } catch (e) {
    return fail(e);
  }
}

// Set a folder's rule ({ dir, rule }, rule null to follow the folder above), or { action: "plan" }
// to have the assistant plan the folder again, or { action: "refile", dir } to send what its rule
// skipped back to the queue
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const editor = requireUser(req, 'editor');
    if (isResponse(editor)) return editor;
    const f = folderOf((await ctx.params).id);
    const b = await req.json();
    if (b.action === 'plan') return NextResponse.json({ job: enqueuePlan(f, typeof b.provider === 'string' && b.provider ? b.provider : undefined) });
    const dir = typeof b.dir === 'string' && b.dir ? b.dir : '.';
    if (b.action === 'refile') return NextResponse.json({ queued: await refile(f.id, dir) });
    if (b.rule !== null && !RULES.includes(b.rule)) throw new Error('Unknown rule.');
    setRule(f.id, dir, b.rule as Rule | null, editor.displayName);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
