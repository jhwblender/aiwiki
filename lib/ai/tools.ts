import { listPages, normalizePath, searchPages } from '../wiki';
import { createChangeSet, createSource, stageContent, workingContent } from '../proposals';
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
  changeSetId: number | null;
  proposed: Map<string, boolean>; // path -> isNew
};

async function ensureChangeSet(ctx: ToolContext, summary: string): Promise<number> {
  if (ctx.changeSetId) return ctx.changeSetId;
  const sourceId = createSource({ kind: 'chat', user: ctx.user, filename: 'Chat', note: ctx.note.slice(0, 400) });
  ctx.changeSetId = createChangeSet(sourceId, summary, `ai:${ctx.providerId}`);
  return ctx.changeSetId;
}

export async function runTool(name: string, args: Record<string, any>, ctx: ToolContext): Promise<string> {
  try {
    switch (name) {
      case 'search_pages': {
        const hits = await searchPages(String(args.query ?? ''));
        if (!hits.length) return 'No matching pages.';
        return hits.map((h) => `${h.path} | ${h.title} | ${h.snippet}`).join('\n');
      }
      case 'list_pages': {
        const pages = await listPages();
        return pages.map((p) => `${p.path} | ${p.title}`).join('\n') || 'The wiki has no pages.';
      }
      case 'read_page': {
        const p = normalizePath(String(args.path ?? ''));
        const w = ctx.changeSetId ? await workingContent(ctx.changeSetId, p) : await workingContent(-1, p);
        return w.exists ? w.content : `No page at "${p}".`;
      }
      case 'replace_in_page': {
        const p = normalizePath(String(args.path ?? ''));
        const oldText = String(args.old_text ?? '');
        const newText = String(args.new_text ?? '');
        if (!oldText) return 'old_text is required.';
        const csId = await ensureChangeSet(ctx, String(args.summary ?? 'Update page'));
        const w = await workingContent(csId, p);
        if (!w.exists) return `No page at "${p}". Use create_page for new pages.`;
        const count = w.content.split(oldText).length - 1;
        if (count === 0) return 'old_text was not found. Call read_page and copy the exact text.';
        if (count > 1) return `old_text matches ${count} places. Include more surrounding text so it is unique.`;
        await stageContent(csId, p, w.content.replace(oldText, () => newText));
        ctx.proposed.set(p, false);
        return `Proposed change to "${p}". It is pending human review and not live yet.`;
      }
      case 'append_to_page': {
        const p = normalizePath(String(args.path ?? ''));
        const csId = await ensureChangeSet(ctx, String(args.summary ?? 'Add to page'));
        const w = await workingContent(csId, p);
        if (!w.exists) return `No page at "${p}". Use create_page for new pages.`;
        const sep = w.content.endsWith('\n') ? '\n' : '\n\n';
        await stageContent(csId, p, w.content + sep + String(args.text ?? '') + '\n');
        ctx.proposed.set(p, false);
        return `Proposed addition to "${p}". It is pending human review and not live yet.`;
      }
      case 'create_page': {
        const p = normalizePath(String(args.path ?? ''));
        const csId = await ensureChangeSet(ctx, String(args.summary ?? 'New page'));
        const w = await workingContent(csId, p);
        if (w.exists) return `A page already exists at "${p}". Use replace_in_page or append_to_page.`;
        await stageContent(csId, p, String(args.content ?? ''));
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
