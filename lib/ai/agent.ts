import { getProvider, Msg } from './providers';
import { normalizeCall, runTool, toolDefs, ToolContext } from './tools';
import type { ChatMsg, ChatResponse } from '../types';

const SYSTEM = `You are the assistant built into a company wiki. You help people find information and keep the wiki accurate.

How you work:
- To answer a question, search the wiki first, read the relevant pages, then answer from what you read. Name the pages you used by their path. If the wiki does not cover it, say so plainly rather than guessing.
- When someone tells you new information or asks you to change the wiki, find the right page with search_pages, read it, then propose the smallest edit that fits (replace_in_page or append_to_page). Only use create_page when no existing page is a sensible home.
- Everything you write is a proposal. Nothing goes live until a person approves it. Never say a change is published; say it is proposed and waiting for review.
- Keep untouched text exactly as it is. Match the page's existing style and keep edits short and factual.
- When information changes or someone corrects it, edit the existing text in place with replace_in_page. Never add a separate "Correction" or "Update" section, and never repeat text that is already on the page.
- If new information contradicts approved text, still edit it in place, and say what it contradicts in the summary and in your reply so the reviewer can check it.
- read_page may list pending suggestions from others after the page text. They are not approved: never answer from them as if they were fact, and do not suggest the same change again. If one already covers what the person told you, say it is waiting for review.
- If the person corrects or adds to something you suggested earlier in this chat, edit the page again; your new edit revises the earlier suggestion.
- Wiki links use [[page/path]] syntax.
- Be concise.`;

export async function runAgent(opts: {
  history: ChatMsg[];
  providerId?: string;
  user: string;
  currentPath?: string;
  chatId?: string;
}): Promise<ChatResponse> {
  const provider = getProvider(opts.providerId);
  const last = [...opts.history].reverse().find((m) => m.role === 'user');
  const ctx: ToolContext = {
    user: opts.user,
    providerId: provider.id,
    note: last?.content ?? '',
    chatId: opts.chatId,
    changeSetId: null,
    proposed: new Map(),
    revising: new Map(),
  };

  const system = opts.currentPath ? `${SYSTEM}\n\nThe person is currently viewing the page "${opts.currentPath}".` : SYSTEM;
  const messages: Msg[] = opts.history.map((m) => ({ role: m.role, content: m.content }) as Msg);
  const trace: string[] = [];
  let reply = '';

  for (let i = 0; i < 10; i++) {
    const res = await provider.chat({ system, messages, tools: toolDefs });
    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls, raw: res.raw });
    if (!res.toolCalls.length) {
      reply = res.text;
      break;
    }
    for (const tc of res.toolCalls) {
      const call = normalizeCall(tc.name, tc.args);
      const result = await runTool(call.name, call.args, ctx);
      // One line per tool call in the server log, for checking how a real model behaves
      console.log(`[assistant] ${call.name} ${JSON.stringify(call.args).slice(0, 300)} -> ${result.split('\n')[0].slice(0, 160)}`);
      trace.push(describe(call.name, call.args));
      // reply under the name the model used, so its own transcript stays consistent
      messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: result });
    }
    if (i === 9) reply = res.text || 'I ran out of steps before finishing. Try a narrower request.';
  }

  return {
    reply,
    trace,
    proposed: [...ctx.proposed.entries()].map(([path, isNew]) => ({ path, isNew })),
  };
}

function describe(name: string, a: Record<string, any>): string {
  switch (name) {
    case 'search_pages': return `Searched for "${a.query}"`;
    case 'list_pages': return 'Listed pages';
    case 'read_page': return `Read ${a.path}`;
    case 'replace_in_page': return `Proposed edit to ${a.path}`;
    case 'append_to_page': return `Proposed addition to ${a.path}`;
    case 'create_page': return `Proposed new page ${a.path}`;
    default: return name;
  }
}
