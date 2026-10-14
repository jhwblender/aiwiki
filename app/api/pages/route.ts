import { NextResponse } from 'next/server';
import { listPages } from '@/lib/wiki';
import { pendingCounts } from '@/lib/proposals';
import { fail } from '@/lib/api';
import type { PageListItem } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
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
        const last = path.split('/').pop() || path;
        items.push({ path, title: last.replace(/[-_]/g, ' '), pending: v.count, isNew: true });
      }
    }
    items.sort((a, b) => a.path.localeCompare(b.path));
    return NextResponse.json(items);
  } catch (e) {
    return fail(e, 500);
  }
}
