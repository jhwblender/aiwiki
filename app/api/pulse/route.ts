import { NextResponse } from 'next/server';
import { stamp } from '@/lib/pulse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Changes whenever a page or suggestion changes; open pages poll it to know when to refresh
export async function GET() {
  return NextResponse.json({ stamp: stamp() }, { headers: { 'Cache-Control': 'no-store' } });
}
