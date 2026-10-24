import { NextResponse } from 'next/server';
import { availableProviders } from '@/lib/ai/providers';
import { needsSetup } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The one public endpoint: the login page needs to know whether accounts exist. Everything else
// asks you to sign in first.
export async function GET() {
  return NextResponse.json({ providers: availableProviders(), needsSetup: needsSetup() });
}
