import { NextRequest, NextResponse } from 'next/server';
import { listPages } from '@/lib/wiki';
import { pendingCounts } from '@/lib/proposals';
import { fail, requireUser, isResponse } from '@/lib/api';
import type { PageListItem } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const viewer = requireUser(req);
    if (isResponse(viewer)) return viewer;
    const pages = await listPages();
    const pending = pendingCounts();
    const items: PageListItem[] = pages.map((p) => ({
      ...p,
      pending: pending.get(p.path)?.count ?? 0,
      isNew: false,
    }));
    const known = new Set(pages.map((p) => p.path));
    for (const [path, v] of pending) {
      if (!known.has(path)) {
        items.push({ path, title: v.title, pending: v.count, isNew: true });
      }
    }
    items.sort((a, b) => a.path.localeCompare(b.path));
    return NextResponse.json(items);
  } catch (e) {
    return fail(e, 500);
  }
}
