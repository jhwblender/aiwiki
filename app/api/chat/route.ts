import { NextRequest, NextResponse } from 'next/server';
import { runAgent } from '@/lib/ai/agent';
import { userFrom } from '@/lib/api';
import type { ChatMsg } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const history: ChatMsg[] = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m: any) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-20);
    if (!history.length || history[history.length - 1].role !== 'user') {
      return NextResponse.json({ reply: '', trace: [], proposed: [], error: 'Send a message first.' }, { status: 400 });
    }
    const result = await runAgent({
      history,
      providerId: body.provider,
      user: userFrom(body.user),
      currentPath: typeof body.currentPath === 'string' ? body.currentPath : undefined,
      attachments: Array.isArray(body.attachments)
        ? body.attachments.map(Number).filter((n: number) => Number.isInteger(n) && n > 0).slice(0, 10)
        : undefined,
      chatId: typeof body.chatId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.chatId) ? body.chatId : undefined,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ reply: '', trace: [], proposed: [], error: e?.message ?? String(e) }, { status: 500 });
  }
}
