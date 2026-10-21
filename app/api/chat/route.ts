import { NextRequest, NextResponse } from 'next/server';
import { runAgent } from '@/lib/ai/agent';
import { userFrom } from '@/lib/api';
import type { ChatMsg } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

// With { stream: true } the reply is newline-delimited JSON: progress events while the
// assistant works, then one "done" (or "error") event with the full result.
export async function POST(req: NextRequest) {
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
  const run = (onProgress?: (text: string) => void) =>
    runAgent({
      history,
      providerId: body.provider,
      user: userFrom(body.user),
      currentPath: typeof body.currentPath === 'string' ? body.currentPath : undefined,
      attachments: Array.isArray(body.attachments)
        ? body.attachments.map(Number).filter((n: number) => Number.isInteger(n) && n > 0).slice(0, 10)
        : undefined,
      chatId: typeof body.chatId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.chatId) ? body.chatId : undefined,
      onProgress,
      signal: req.signal,
    });

  if (!body.stream) {
    try {
      return NextResponse.json(await run());
    } catch (e: any) {
      return NextResponse.json({ reply: '', trace: [], proposed: [], error: e?.message ?? String(e) }, { status: 500 });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch {
          // the browser went away
        }
      };
      try {
        const result = await run((text) => send({ type: 'progress', text }));
        send({ type: 'done', ...result });
      } catch (e: any) {
        send({ type: 'error', error: e?.message ?? String(e) });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      // no-transform keeps the server from compressing (and so holding back) the progress lines
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
