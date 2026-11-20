import { NextRequest, NextResponse } from 'next/server';
import { opsTokenMatches } from '@/lib/opsToken';
import { activeRuns } from '@/lib/runs';
import { holdForRestart, restartState } from '@/lib/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// For the update script only (it holds the secret from lib/opsToken.ts): whether the assistant is
// in use, so the wiki restarts at a quiet moment instead of cutting off a reply or a filing job
function state() {
  const chats = activeRuns();
  const s = restartState();
  return { quiet: chats === 0 && !s.job && !s.chatHoldUntil, chats, ...s };
}

function allowed(req: NextRequest) {
  return opsTokenMatches(req.headers.get('x-ops-token'));
}

export async function GET(req: NextRequest) {
  if (!allowed(req)) return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  return NextResponse.json(state(), { headers: { 'Cache-Control': 'no-store' } });
}

// { holdMinutes }: claim no new filing jobs for that long (0 lets them go again)
export async function POST(req: NextRequest) {
  if (!allowed(req)) return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const minutes = Math.min(120, Math.max(0, Number(body?.holdMinutes) || 0));
  holdForRestart(minutes);
  return NextResponse.json(state());
}
