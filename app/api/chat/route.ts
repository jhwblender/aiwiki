import { NextRequest, NextResponse } from 'next/server';
import { runAgent } from '@/lib/ai/agent';
import { requireUser, isResponse } from '@/lib/api';
import { runStream, startRun } from '@/lib/runs';
import type { ChatMsg } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

// With { stream: true } the reply is newline-delimited JSON: a "run" event with an id the chat can
// reconnect to (/api/chat/runs/:id), progress events while the assistant works, then one "done"
// (or "error") event with the full result. Leaving the page does not stop the run.
export async function POST(req: NextRequest) {
  const chatter = requireUser(req);
  if (isResponse(chatter)) return chatter;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ reply: '', trace: [], proposed: [], error: 'The request was not valid.' }, { status: 400 });
  }
  const history: ChatMsg[] = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m: any) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20);
  if (!history.length || history[history.length - 1].role !== 'user') {
    return NextResponse.json({ reply: '', trace: [], proposed: [], error: 'Send a message first.' }, { status: 400 });
  }
  const run = (onProgress?: (text: string) => void, signal?: AbortSignal) =>
    runAgent({
      history,
      providerId: body.provider,
      user: chatter.displayName,
      username: chatter.name,
      currentPath: typeof body.currentPath === 'string' ? body.currentPath : undefined,
      attachments: Array.isArray(body.attachments)
        ? body.attachments.map(Number).filter((n: number) => Number.isInteger(n) && n > 0).slice(0, 10)
        : undefined,
      chatId: typeof body.chatId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.chatId) ? body.chatId : undefined,
      onProgress,
      signal,
    });

  if (!body.stream) {
    try {
      return NextResponse.json(await run());
    } catch (e: any) {
      return NextResponse.json({ reply: '', trace: [], proposed: [], error: e?.message ?? String(e) }, { status: 500 });
    }
  }

  // Streamed: the work runs on the server whether or not this browser stays connected
  const id = startRun((onProgress, signal) => run(onProgress, signal));
  return runStream(id)!;
}
