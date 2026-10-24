import { NextRequest, NextResponse } from 'next/server';
import { stamp } from '@/lib/pulse';
import { requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Changes whenever a page or suggestion changes; open pages poll it to know when to refresh
export async function GET(req: NextRequest) {
  const viewer = requireUser(req);
  if (isResponse(viewer)) return viewer;
  return NextResponse.json({ stamp: stamp() }, { headers: { 'Cache-Control': 'no-store' } });
}
