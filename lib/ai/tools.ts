import { listPages, normalizePath, readPage, searchPages } from '../wiki';
import { chatPending, createChangeSet, createSource, pendingCounts, pendingForPage, stageContent, stagedContent, supersede } from '../proposals';
import type { PendingSet } from '../types';
import { toBlocks } from '../diff';
import type { ToolDef } from './providers';

export const toolDefs: ToolDef[] = [
  {
    name: 'search_pages',
    description: 'Full-text search across all wiki pages. Returns matching page paths with snippets. Use this before reading or editing.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'list_pages',
    description: 'List every page in the wiki with its title.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'read_page',
    description: 'Read the full markdown of a page by path (for example "systems/onboarding"). Includes any edits you already proposed in this conversation turn.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'replace_in_page',
    description:
      'Propose replacing an exact passage in an existing page. old_text must match the page text exactly once. The change is NOT published; it is a proposal a human reviews.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string', description: 'Exact text currently on the page. Keep it short but unique.' },
        new_text: { type: 'string' },
        summary: { type: 'string', description: 'One short sentence describing the change, for the reviewer.' },
      },
      required: ['path', 'old_text', 'new_text', 'summary'],
    },
  },
  {
    name: 'append_to_page',
    description: 'Propose adding markdown to the end of an existing page. Not published until a human approves.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, text: { type: 'string' }, summary: { type: 'string' } },
      required: ['path', 'text', 'summary'],
    },
  },
  {
    name: 'create_page',
    description: 'Propose a brand new page. Start the markdown with a "# Title" heading. Not published until a human approves.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'For example "vendors/acme-pumps"' }, content: { type: 'string' }, summary: { type: 'string' } },
      required: ['path', 'content', 'summary'],
    },
  },
];

export type ToolContext = {
  user: string;
  providerId: string;
  note: string; // the user message that triggered this run
  chatId?: string; // the chat conversation, so a follow-up message can revise its earlier suggestion
  changeSetId: number | null;
  proposed: Map<string, boolean>; // path -> isNew
  revising: Map<string, number>; // path -> earlier suggestion from this chat that this run replaces
};

async function ensureChangeSet(ctx: ToolContext, summary: string): Promise<number> {
  if (ctx.changeSetId) return ctx.changeSetId;
  const sourceId = createSource({ kind: 'chat', user: ctx.user, filename: 'Chat', note: ctx.note.slice(0, 400) });
  ctx.changeSetId = createChangeSet(sourceId, summary, `ai:${ctx.providerId}`, ctx.chatId);
  return ctx.changeSetId;
}

// The text the assistant edits: what it already staged this run, else this chat's own pending
// suggestion, else the approved page.
async function working(ctx: ToolContext, p: string): Promise<{ content: string; exists: boolean; revising: number | null }> {
  if (ctx.changeSetId) {
    const staged = stagedContent(ctx.changeSetId, p);
    if (staged !== null) return { content: staged, exists: true, revising: ctx.revising.get(p) ?? null };
  }
  if (ctx.chatId) {
    const earlier = await chatPending(ctx.chatId, ctx.user, p, ctx.changeSetId);
    if (earlier) return { content: earlier.content, exists: true, revising: earlier.proposalId };
  }
  const live = await readPage(p);
  return { content: live ?? '', exists: live !== null, revising: null };
}

async function stage(ctx: ToolContext, csId: number, p: string, content: string, revising: number | null) {
  await stageContent(csId, p, content);
  if (revising !== null && !ctx.revising.has(p)) {
    supersede(revising, csId, p, ctx.user);
    ctx.revising.set(p, revising);
  }
}

// Paragraphs of new text that already appear word for word on the page (headings excepted)
function repeatedBlocks(existing: string, added: string): string[] {
  const have = new Set(toBlocks(existing).map((b) => b.trim()));
  return toBlocks(added).filter((b) => !/^#{1,6}\s/.test(b) && have.has(b.trim()));
}

const clip = (s: string, n = 400) => (s.length > n ? s.slice(0, n) + '...' : s);

// Suggestions on this page from other chats or people, kept apart from the approved text.
async function othersPending(ctx: ToolContext, p: string, revising: number | null): Promise<PendingSet[]> {
  return (await pendingForPage(p)).filter((s) => s.changeSetId !== ctx.changeSetId && s.proposalId !== revising).slice(0, 5);
}

function describePending(sets: PendingSet[]): string {
  return sets
    .map((s, i) => {
      const who = s.source ? `${s.source.kind} from ${s.source.user}` : 'unknown source';
      const lines = [`${i + 1}. "${s.summary}" (${who}${s.conflict ? '; out of date, will likely be rejected' : ''})`];
      for (const seg of s.segments) {
        if (seg.type !== 'change') continue;
        if (seg.removed.length) lines.push(`   Would remove: ${clip(seg.removed.join(' / '))}`);
        if (seg.added.length) lines.push(`   Would add: ${clip(seg.added.join(' / '))}`);
      }
      return lines.join('\n');
    })
    .join('\n');
}

const PENDING_HEADER =
  'Pending suggestions from others, NOT approved and NOT part of the page. Do not state them as fact. ' +
  'Do not suggest the same change again; mention that it is already waiting for review instead:';

// Smaller local models often call a tool by a slightly different name or pass an argument
// under a near-miss key. Map unambiguous variants to the real ones so the call still runs.
const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

const ARG_ALIASES: Record<string, string[]> = {
  path: ['page', 'pagepath', 'slug', 'pagename', 'name'],
  query: ['q', 'search', 'term', 'terms', 'keywords'],
  old_text: ['oldtext', 'old', 'find', 'search', 'original', 'existingtext', 'from'],
  new_text: ['newtext', 'new', 'replace', 'replacement', 'to'],
  text: ['content', 'markdown', 'body', 'addition'],
  content: ['text', 'markdown', 'body'],
  summary: ['description', 'reason', 'message'],
};

export function normalizeCall(name: string, rawArgs: unknown): { name: string; args: Record<string, any> } {
  const def = toolDefs.find((d) => d.name === name) ?? toolDefs.find((d) => squash(d.name) === squash(String(name ?? '')));
  let args: any = rawArgs;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  if (!def) return { name: String(name ?? ''), args };
  const wanted = Object.keys((def.parameters as any).properties ?? {});
  const out: Record<string, any> = {};
  for (const key of wanted) {
    if (args[key] !== undefined) {
      out[key] = args[key];
      continue;
    }
    const match = Object.keys(args).find((k) => squash(k) === squash(key) || (ARG_ALIASES[key] ?? []).includes(squash(k)));
    if (match !== undefined && !wanted.includes(match)) out[key] = args[match];
  }
  return { name: def.name, args: out };
}

function missing(name: string, args: Record<string, any>): string | null {
  const def = toolDefs.find((d) => d.name === name);
  const required: string[] = ((def?.parameters as any)?.required ?? []) as string[];
  const gone = required.filter((k) => args[k] === undefined || args[k] === null || String(args[k]).trim() === '');
  if (!gone.length) return null;
  return `Error: ${name} needs ${gone.join(', ')}. Expected arguments: ${required.join(', ')}. Call it again with all of them.`;
}

export async function runTool(name: string, args: Record<string, any>, ctx: ToolContext): Promise<string> {
  if (!toolDefs.some((d) => d.name === name)) {
    return `Error: there is no tool called "${name}". Available tools: ${toolDefs.map((d) => d.name).join(', ')}.`;
  }
  const absent = missing(name, args);
  if (absent) return absent;
  try {
    switch (name) {
      case 'search_pages': {
        const hits = await searchPages(String(args.query ?? ''));
        if (!hits.length) return 'No matching pages.';
        const pending = pendingCounts();
        return hits
          .map((h) => {
            const n = pending.get(h.path)?.count ?? 0;
            return `${h.path} | ${h.title} | ${h.snippet}${n ? ` | ${n} pending suggestion${n > 1 ? 's' : ''}, see read_page` : ''}`;
          })
          .join('\n');
      }
      case 'list_pages': {
        const pages = await listPages();
        const known = new Set(pages.map((p) => p.path));
        const lines = pages.map((p) => `${p.path} | ${p.title}`);
        for (const [path, v] of pendingCounts()) {
          if (!known.has(path)) lines.push(`${path} | ${v.title} | suggested new page, not approved yet`);
        }
        return lines.join('\n') || 'The wiki has no pages.';
      }
      case 'read_page': {
        const p = normalizePath(String(args.path ?? ''));
        const w = await working(ctx, p);
        const others = await othersPending(ctx, p, w.revising);
        const parts: string[] = [];
        if (w.exists) parts.push(w.content);
        else if (others.some((o) => o.isNew)) parts.push(`No approved page at "${p}" yet, but a new page here is already suggested.`);
        else return `No page at "${p}".`;
        if (w.revising !== null) {
          parts.push(
            '(This text includes your own suggestion from earlier in this chat, still waiting for review. ' +
              'Edits you make now revise that suggestion instead of adding a second one.)',
          );
        }
        if (others.length) parts.push(`---\n${PENDING_HEADER}\n${describePending(others)}`);
        return parts.join('\n\n');
      }
      case 'replace_in_page': {
        const p = normalizePath(String(args.path ?? ''));
        const oldText = String(args.old_text ?? '');
        const newText = String(args.new_text ?? '');
        if (!oldText) return 'old_text is required.';
        const w = await working(ctx, p);
        if (!w.exists) return `No page at "${p}". Use create_page for new pages.`;
        const count = w.content.split(oldText).length - 1;
        if (count === 0) return 'old_text was not found. Call read_page and copy the exact text.';
        if (count > 1) return `old_text matches ${count} places. Include more surrounding text so it is unique.`;
        const csId = await ensureChangeSet(ctx, String(args.summary ?? 'Update page'));
        await stage(ctx, csId, p, w.content.replace(oldText, () => newText), w.revising);
        ctx.proposed.set(p, false);
        return `Proposed change to "${p}". It is pending human review and not live yet.`;
      }
      case 'append_to_page': {
        const p = normalizePath(String(args.path ?? ''));
        const w = await working(ctx, p);
        if (!w.exists) return `No page at "${p}". Use create_page for new pages.`;
        const repeats = repeatedBlocks(w.content, String(args.text ?? ''));
        if (repeats.length) {
          return (
            `Error: this text is already on the page: "${clip(repeats[0], 160)}". Nothing was added. ` +
            'To correct or update something, change it in place with replace_in_page instead of adding a new section.'
          );
        }
        const csId = await ensureChangeSet(ctx, String(args.summary ?? 'Add to page'));
        const sep = w.content.endsWith('\n') ? '\n' : '\n\n';
        await stage(ctx, csId, p, w.content + sep + String(args.text ?? '') + '\n', w.revising);
        ctx.proposed.set(p, false);
        return `Proposed addition to "${p}". It is pending human review and not live yet.`;
      }
      case 'create_page': {
        const p = normalizePath(String(args.path ?? ''));
        const w = await working(ctx, p);
        if (w.revising !== null) return `You already suggested a page at "${p}" in this chat. Use replace_in_page or append_to_page to revise it.`;
        if (w.exists) return `A page already exists at "${p}". Use replace_in_page or append_to_page.`;
        const rival = (await othersPending(ctx, p, null)).find((o) => o.isNew);
        if (rival) return `A new page at "${p}" is already suggested and waiting for review ("${rival.summary}"). Do not suggest it again; tell the person it is pending.`;
        const csId = await ensureChangeSet(ctx, String(args.summary ?? 'New page'));
        await stage(ctx, csId, p, String(args.content ?? ''), null);
        ctx.proposed.set(p, true);
        return `Proposed new page "${p}". It is pending human review and not live yet.`;
      }
      default:
        return `Unknown tool ${name}.`;
    }
  } catch (e: any) {
    return `Error: ${e?.message ?? e}`;
  }
}
