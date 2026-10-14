import { NextResponse } from 'next/server';
import { availableProviders } from '@/lib/ai/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ providers: availableProviders() });
}
