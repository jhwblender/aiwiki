import Anthropic from '@anthropic-ai/sdk';
import { localModelSettings } from '../settings';
import { localProvider } from './local';

// A thin provider interface. The agent loop and the wiki tools never know which model is behind it.

export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolCall = { id: string; name: string; args: Record<string, any> };
export type Msg =
  | { role: 'user'; content: string }
  // raw: the provider's own response blocks, replayed unchanged by the same provider and ignored by others
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; raw?: unknown }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface Provider {
  id: 'anthropic' | 'local';
  label: string;
  chat(req: { system: string; messages: Msg[]; tools: ToolDef[] }): Promise<{ text: string; toolCalls: ToolCall[]; raw?: unknown }>;
  // Read a photo or a scanned page and answer the prompt about it in text
  describeImage(image: { data: Buffer; mime: string }, prompt: string): Promise<string>;
}

// ---------- Anthropic ----------

// Fallback models used when Claude declines a request for policy reasons (Claude API only).
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function anthropicProvider(): Provider {
  const model = anthropicModel();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return {
    id: 'anthropic',
    label: `Anthropic (${model})`,
    async chat({ system, messages, tools }) {
      const msgs: Anthropic.Beta.BetaMessageParam[] = [];
      for (const m of messages) {
        if (m.role === 'user') {
          msgs.push({ role: 'user', content: m.content });
        } else if (m.role === 'assistant') {
          // Replay this provider's own blocks unchanged: thinking blocks must come back
          // exactly as received or the API rejects the tool loop.
          if (Array.isArray(m.raw)) {
            msgs.push({ role: 'assistant', content: m.raw as Anthropic.Beta.BetaContentBlockParam[] });
            continue;
          }
          const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
          if (m.content) blocks.push({ type: 'text', text: m.content });
          for (const tc of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
          if (blocks.length) msgs.push({ role: 'assistant', content: blocks });
        } else {
          const block: Anthropic.Beta.BetaToolResultBlockParam = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) {
            last.content.push(block);
          } else {
            msgs.push({ role: 'user', content: [block] });
          }
        }
      }
      let res: Anthropic.Beta.BetaMessage;
      try {
        res = await client.beta.messages.create({
          model,
          max_tokens: 16000,
          system,
          messages: msgs,
          ...(tools.length
            ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema })) }
            : {}),
          output_config: { effort: 'medium' },
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
        });
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new Error('The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.local.');
        if (e instanceof Anthropic.NotFoundError) throw new Error(`Anthropic does not recognise the model "${model}". Check ANTHROPIC_MODEL.`);
        if (e instanceof Anthropic.RateLimitError) throw new Error('The Anthropic API is rate limiting requests. Try again in a minute.');
        throw e;
      }
      if (res.stop_reason === 'refusal') {
        return { text: 'I cannot help with that request.', toolCalls: [] };
      }
      let text = '';
      const toolCalls: ToolCall[] = [];
      for (const b of res.content) {
        if (b.type === 'text') text += b.text;
        if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, args: (b.input as Record<string, any>) ?? {} });
      }
      if (res.stop_reason === 'max_tokens' && !toolCalls.length) text += '\n\n(The reply was cut off because it was too long.)';
      return { text, toolCalls, raw: res.content };
    },
    async describeImage(image, prompt) {
      const res = await client.messages.create({
        model,
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: image.mime as 'image/png', data: image.data.toString('base64') },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
      });
      if (res.stop_reason === 'refusal') throw new Error('The model declined to describe this image.');
      return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
    },
  };
}

// ---------- registry ----------

export function availableProviders(): { id: 'anthropic' | 'local'; label: string }[] {
  const out: { id: 'anthropic' | 'local'; label: string }[] = [];
  if (process.env.ANTHROPIC_API_KEY) out.push({ id: 'anthropic', label: anthropicLabel() });
  const local = localModelSettings();
  if (local.baseUrl) out.push({ id: 'local', label: `Local (${local.model})` });
  return out;
}

export function anthropicModel() {
  return process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
}

function anthropicLabel() {
  return `Anthropic (${anthropicModel()})`;
}

export function getProvider(id?: string): Provider {
  const avail = availableProviders();
  if (!avail.length) throw new Error('No AI model is set up. Add a local model on the Settings page, or ANTHROPIC_API_KEY in .env.local.');
  const pick = avail.find((a) => a.id === id) ?? avail[0];
  return pick.id === 'anthropic' ? anthropicProvider() : localProvider(localModelSettings());
}
