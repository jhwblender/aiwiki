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
- Pages can have sub-pages: "systems/networking" sits under "systems". Put new pages where they belong in that tree.
- To reorganise, use move_page to move or rename (sub-pages and links follow), create_page plus replace_in_page to split a page, and append_to_page on the target plus remove_page on the old page to merge. Explain the plan in your reply.
- Wiki links use [[page/path]] syntax.
- Be concise.`;

// A reply that says a change was made or is waiting for review. Smaller models sometimes write
// this without calling any tool, which leaves the person looking for a suggestion that does not exist.
const CLAIMS_CHANGE =
  /\b(I(?:'ve| have| just)?\s+(?:now\s+)?(?:proposed|suggested|moved|renamed|added|updated|created|changed|edited|removed)|(?:waiting|pending)\s+(?:for\s+)?(?:human\s+)?(?:review|approval))\b/i;

const NUDGE =
  '(Automatic check) Your reply says you suggested or made a change, but you did not call any tool, so nothing was suggested and nothing is waiting for review. ' +
  'If a change is needed, call the right tool now (replace_in_page, append_to_page, create_page, move_page or remove_page). ' +
  'If not, answer again without saying that you changed anything.';

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

  let nudged = false;
  for (let i = 0; i < 10; i++) {
    const res = await provider.chat({ system, messages, tools: toolDefs });
    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls, raw: res.raw });
    if (!res.toolCalls.length) {
      if (!nudged && ctx.proposed.size === 0 && CLAIMS_CHANGE.test(res.text)) {
        nudged = true;
        console.log('[assistant] reply claims a change but no tool was called; asking it to call the tool');
        messages.push({ role: 'user', content: NUDGE });
        continue;
      }
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

  if (ctx.proposed.size === 0 && CLAIMS_CHANGE.test(reply)) {
    reply += '\n\n_No change was actually suggested, so nothing is waiting for review. Try asking again, more specifically._';
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
    case 'move_page': return `Proposed moving ${a.path} to ${a.new_path}`;
    case 'remove_page': return `Proposed removing ${a.path}`;
    default: return name;
  }
}
