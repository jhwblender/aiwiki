import { NextRequest, NextResponse } from 'next/server';
import { localModelSettings, saveLocalModelSettings } from '@/lib/settings';
import { anthropicModel } from '@/lib/ai/providers';
import { fail } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The saved API key is never sent back to the browser, only whether one is set
function view() {
  const local = localModelSettings();
  return {
    local: { baseUrl: local.baseUrl, model: local.model, hasApiKey: !!local.apiKey },
    anthropic: { configured: !!process.env.ANTHROPIC_API_KEY, model: anthropicModel() },
  };
}

export async function GET() {
  return NextResponse.json(view());
}

export async function PUT(req: NextRequest) {
  try {
    const b = await req.json();
    saveLocalModelSettings({
      baseUrl: String(b.baseUrl ?? ''),
      model: String(b.model ?? ''),
      apiKey: typeof b.apiKey === 'string' ? b.apiKey : undefined,
    });
    return NextResponse.json(view());
  } catch (e) {
    return fail(e);
  }
}
