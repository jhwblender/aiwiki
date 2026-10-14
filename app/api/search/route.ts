import { NextRequest, NextResponse } from 'next/server';
import { searchPages } from '@/lib/wiki';
import { fail } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    return NextResponse.json(await searchPages(req.nextUrl.searchParams.get('q') || '', 10));
  } catch (e) {
    return fail(e, 500);
  }
}
