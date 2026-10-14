import Anthropic from '@anthropic-ai/sdk';

// A thin provider interface. The agent loop and the wiki tools never know which model is behind it.

export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolCall = { id: string; name: string; args: Record<string, any> };
export type Msg =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface Provider {
  id: 'anthropic' | 'local';
  label: string;
  chat(req: { system: string; messages: Msg[]; tools: ToolDef[] }): Promise<{ text: string; toolCalls: ToolCall[] }>;
}

// ---------- Anthropic ----------

function anthropicProvider(): Provider {
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return {
    id: 'anthropic',
    label: `Anthropic (${model})`,
    async chat({ system, messages, tools }) {
      const msgs: any[] = [];
      for (const m of messages) {
        if (m.role === 'user') {
          msgs.push({ role: 'user', content: m.content });
        } else if (m.role === 'assistant') {
          const blocks: any[] = [];
          if (m.content) blocks.push({ type: 'text', text: m.content });
          for (const tc of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
          if (blocks.length) msgs.push({ role: 'assistant', content: blocks });
        } else {
          const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b: any) => b.type === 'tool_result')) {
            last.content.push(block);
          } else {
            msgs.push({ role: 'user', content: [block] });
          }
        }
      }
      const res = await client.messages.create({
        model,
        max_tokens: 4096,
        system,
        messages: msgs,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as any })),
      });
      let text = '';
      const toolCalls: ToolCall[] = [];
      for (const b of res.content as any[]) {
        if (b.type === 'text') text += b.text;
        if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, args: b.input ?? {} });
      }
      return { text, toolCalls };
    },
  };
}

// ---------- Local (any OpenAI-compatible server: Ollama, LM Studio, vLLM) ----------

function localProvider(): Provider {
  const base = (process.env.LOCAL_LLM_BASE_URL || '').replace(/\/$/, '');
  const model = process.env.LOCAL_LLM_MODEL || 'qwen2.5:14b-instruct';
  return {
    id: 'local',
    label: `Local (${model})`,
    async chat({ system, messages, tools }) {
      const msgs: any[] = [{ role: 'system', content: system }];
      for (const m of messages) {
        if (m.role === 'user') msgs.push({ role: 'user', content: m.content });
        else if (m.role === 'assistant') {
          const entry: any = { role: 'assistant', content: m.content || '' };
          if (m.toolCalls?.length) {
            entry.tool_calls = m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            }));
          }
          msgs.push(entry);
        } else {
          msgs.push({ role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content });
        }
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (process.env.LOCAL_LLM_API_KEY) headers.Authorization = `Bearer ${process.env.LOCAL_LLM_API_KEY}`;
      const resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: msgs,
          temperature: 0.2,
          tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        }),
      });
      if (!resp.ok) throw new Error(`Local model returned ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
      const data: any = await resp.json();
      const msg = data.choices?.[0]?.message ?? {};
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any, i: number) => {
        let args: Record<string, any> = {};
        try {
          args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : tc.function?.arguments ?? {};
        } catch {
          args = {};
        }
        return { id: tc.id || `call_${Date.now()}_${i}`, name: tc.function?.name, args };
      });
      return { text: msg.content ?? '', toolCalls };
    },
  };
}

// ---------- registry ----------

export function availableProviders(): { id: 'anthropic' | 'local'; label: string }[] {
  const out: { id: 'anthropic' | 'local'; label: string }[] = [];
  if (process.env.ANTHROPIC_API_KEY) out.push({ id: 'anthropic', label: anthropicLabel() });
  if (process.env.LOCAL_LLM_BASE_URL) out.push({ id: 'local', label: `Local (${process.env.LOCAL_LLM_MODEL || 'qwen2.5:14b-instruct'})` });
  return out;
}

function anthropicLabel() {
  return `Anthropic (${process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'})`;
}

export function getProvider(id?: string): Provider {
  const avail = availableProviders();
  if (!avail.length) throw new Error('No AI provider configured. Set ANTHROPIC_API_KEY or LOCAL_LLM_BASE_URL in .env.local.');
  const pick = avail.find((a) => a.id === id) ?? avail[0];
  return pick.id === 'anthropic' ? anthropicProvider() : localProvider();
}
