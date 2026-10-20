import { NextRequest, NextResponse } from 'next/server';
import { cleanBaseUrl, localModelSettings } from '@/lib/settings';
import { testLocalModel } from '@/lib/ai/local';
import { fail } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 400;

// Tests the values in the form, so they can be checked before saving.
// A blank API key means "use the saved one".
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const saved = localModelSettings();
    const result = await testLocalModel({
      baseUrl: cleanBaseUrl(String(b.baseUrl ?? '')),
      model: String(b.model ?? '').trim(),
      apiKey: typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : saved.apiKey,
    });
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}
