import http from 'node:http';
import https from 'node:https';
import type { LocalModelSettings } from '../settings';
import type { Provider, ToolCall } from './providers';

// Any OpenAI-compatible server: Ollama, LM Studio, vLLM.

// Turns network failures into a sentence a non-programmer can act on.
function describeFailure(e: unknown, url: string, seconds: number): string {
  const err = e as { name?: string; cause?: unknown; code?: string };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    const mins = seconds >= 120 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`;
    return `No answer from ${url} within ${mins}. The model may be too slow for this much text; a smaller model or a shorter document helps.`;
  }
  if (err?.code === 'ERR_INVALID_URL') return `${url} is not a valid web address.`;
  // The useful code is on the error itself, or a few causes deep
  let code: string | undefined = err?.code;
  let reason = '';
  for (let c: any = err?.cause; c && !code; c = c.cause) {
    code = c.code ?? c.errors?.find((x: any) => x?.code)?.code;
    reason ||= c.message ?? '';
  }
  if (reason === 'bad port') return `The port in ${url} is one that web requests are not allowed to use. Pick a different port.`;
  switch (code) {
    case 'ECONNREFUSED':
      return `Nothing is answering at ${url}. Check that Ollama or LM Studio is running and the address is right.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `The server name in ${url} could not be found. Check the address.`;
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
      return `Could not connect to ${url}. Check that Ollama or LM Studio is running, and that a firewall or WSL networking is not blocking the connection.`;
    case 'ECONNRESET':
      return `The connection to ${url} was dropped. The server may have crashed or run out of memory.`;
  }
  return `Could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`;
}

function describeStatus(status: number, body: string): string {
  if (status === 401 || status === 403) return 'The model server rejected the API key.';
  if (status === 404) {
    if (/model/i.test(body)) return `The model server does not have that model. ${body.slice(0, 200)}`;
    return 'The model server answered, but not at this address. Addresses usually end in /v1, for example http://localhost:11434/v1.';
  }
  return `The model server returned an error (${status}): ${body.slice(0, 300)}`;
}

const CONNECT_MS = 10_000;

// One request with Node's own http module. fetch is not used for model calls: it gives up after five
// minutes without a reply, whatever timeout is asked for, and a large local model on a long prompt
// can take longer than that before it answers at all.
function send(url: string, method: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(Object.assign(new Error('Invalid address'), { code: 'ERR_INVALID_URL' }));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers: body === undefined ? headers : { ...headers, 'Content-Length': String(Buffer.byteLength(body)) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        cleanupAbort();
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', fail);
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), timeoutMs);
    // A stopping run cuts the request as soon as it is asked to, instead of waiting out the
    // model's whole answer.
    const onAbort = () => req.destroy(Object.assign(new Error('stopped'), { name: 'AbortError' }));
    const cleanupAbort = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort);
    req.on('socket', (sock) => {
      // a long wait for the answer must not look like a dead connection to anything in between
      sock.setKeepAlive(true, 30_000);
      if (!sock.connecting) return;
      const connect = setTimeout(() => req.destroy(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' })), CONNECT_MS);
      sock.once('connect', () => clearTimeout(connect));
      sock.once('close', () => clearTimeout(connect));
    });
    req.on('error', fail);
    function fail(e: unknown) {
      clearTimeout(timer);
      cleanupAbort();
      reject(e);
    }
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export async function localRequest(
  s: LocalModelSettings,
  path: string,
  body: unknown | undefined,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<any> {
  if (!s.baseUrl) throw new Error('No local model address is set. Add one on the Settings page.');
  const url = `${s.baseUrl}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
  let status: number;
  let text: string;
  try {
    ({ status, text } = await send(url, body === undefined ? 'GET' : 'POST', headers, body === undefined ? undefined : JSON.stringify(body), timeoutSeconds * 1000, signal));
  } catch (e) {
    throw new Error(describeFailure(e, s.baseUrl, timeoutSeconds));
  }
  if (status < 200 || status >= 300) throw new Error(describeStatus(status, text));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The server at ${s.baseUrl} answered with something other than JSON. Is this the right address?`);
  }
}

function parseToolCalls(msg: any): ToolCall[] {
  return (msg?.tool_calls ?? []).map((tc: any, i: number) => {
    let args: Record<string, any> = {};
    try {
      args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : tc.function?.arguments ?? {};
    } catch {
      args = {};
    }
    return { id: tc.id || `call_${Date.now()}_${i}`, name: tc.function?.name, args };
  });
}

export function localProvider(s: LocalModelSettings): Provider {
  return {
    id: 'local',
    label: `Local (${s.model})`,
    async chat({ system, messages, tools, signal }) {
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
      // A large local model on a processor can take many minutes on a long document
      const data = await localRequest(
        s,
        '/chat/completions',
        {
          model: s.model,
          messages: msgs,
          temperature: 0.2,
          // a plain question (no tools) leaves the field out; some servers reject an empty list
          ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
        },
        900,
        signal,
      );
      const msg = data.choices?.[0]?.message ?? {};
      return { text: msg.content ?? '', toolCalls: parseToolCalls(msg) };
    },
    describeImage(image, prompt, signal) {
      return describeLocalImage(s, image, prompt, signal);
    },
  };
}

export async function describeLocalImage(s: LocalModelSettings, image: { data: Buffer; mime: string }, prompt: string, signal?: AbortSignal): Promise<string> {
  const model = s.visionModel || s.model;
  const data = await localRequest(
    s,
    '/chat/completions',
    {
      model,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data.toString('base64')}` } },
          ],
        },
      ],
    },
    900,
    signal,
  );
  const text = String(data.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error(`${model} returned nothing for the image. It may not be able to read images; set a vision model on the Settings page.`);
  return text;
}

// ---------- connection test (Settings page) ----------

// optional steps do not stop the assistant from working, so they do not fail the whole test
export type TestStep = { label: string; status: 'passed' | 'failed' | 'skipped'; detail: string; optional?: boolean };

// A small picture with one word on it, to check the model can actually read images
async function wordPicture(word: string): Promise<Buffer> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(320, 120);
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 320, 120);
  g.fillStyle = '#000000';
  g.font = 'bold 64px sans-serif';
  g.fillText(word, 40, 85);
  return canvas.toBuffer('image/png');
}

export async function testLocalModel(s: LocalModelSettings): Promise<{ ok: boolean; steps: TestStep[]; models: string[] }> {
  const steps: TestStep[] = [];
  let models: string[] = [];
  const skip = (label: string) => steps.push({ label, status: 'skipped', detail: 'Skipped because an earlier step failed.' });

  // 1. Reach the server
  try {
    // Longer than the 10 second connect timeout, so a failed connection reports its real cause
    const list = await localRequest(s, '/models', undefined, 15);
    models = (list.data ?? list.models ?? []).map((m: any) => String(m.id ?? m.name)).filter(Boolean);
    steps.push({ label: 'Reach the model server', status: 'passed', detail: `Connected to ${s.baseUrl}.` });
  } catch (e: any) {
    steps.push({ label: 'Reach the model server', status: 'failed', detail: e.message });
    ['Find the model', 'Get a reply', 'Use wiki tools'].forEach(skip);
    return { ok: false, steps, models };
  }

  // 2. Find the model (some servers do not list models; the next step decides then)
  if (!models.length) {
    steps.push({ label: 'Find the model', status: 'passed', detail: 'The server does not list its models, so the next step checks the name.' });
  } else if (models.includes(s.model)) {
    steps.push({ label: 'Find the model', status: 'passed', detail: `${s.model} is available.` });
  } else {
    steps.push({ label: 'Find the model', status: 'failed', detail: `${s.model || 'No model'} is not on this server. Available: ${models.join(', ')}.` });
    ['Get a reply', 'Use wiki tools'].forEach(skip);
    return { ok: false, steps, models };
  }

  // 3. Get a reply
  try {
    const started = Date.now();
    const data = await localRequest(
      s,
      '/chat/completions',
      { model: s.model, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], temperature: 0, max_tokens: 20 },
      180,
    );
    const text = String(data.choices?.[0]?.message?.content ?? '').trim();
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    steps.push({ label: 'Get a reply', status: 'passed', detail: `Answered in ${secs} seconds${text ? `: "${text.slice(0, 60)}"` : ''}.` });
  } catch (e: any) {
    steps.push({ label: 'Get a reply', status: 'failed', detail: e.message });
    skip('Use wiki tools');
    return { ok: false, steps, models };
  }

  // 4. The assistant only works with models that can call tools
  try {
    const data = await localRequest(
      s,
      '/chat/completions',
      {
        model: s.model,
        messages: [{ role: 'user', content: 'Call the ping tool now.' }],
        temperature: 0,
        tools: [{ type: 'function', function: { name: 'ping', description: 'Checks that tool calling works.', parameters: { type: 'object', properties: {} } } }],
      },
      180,
    );
    const calls = parseToolCalls(data.choices?.[0]?.message);
    if (calls.some((c) => c.name === 'ping')) {
      steps.push({ label: 'Use wiki tools', status: 'passed', detail: 'The model can call tools, so it can search the wiki and suggest edits.' });
    } else {
      steps.push({
        label: 'Use wiki tools',
        status: 'failed',
        detail: 'The model answered without calling a tool. The assistant needs a model with tool calling, for example qwen2.5 or llama3.1.',
      });
    }
  } catch (e: any) {
    steps.push({ label: 'Use wiki tools', status: 'failed', detail: e.message });
  }

  // 5. Photos and scanned pages need a model that can see images
  const visionLabel = 'Read photos (optional)';
  const visionModel = s.visionModel || s.model;
  if (s.visionModel && models.length && !models.includes(s.visionModel)) {
    steps.push({ label: visionLabel, status: 'failed', optional: true, detail: `${s.visionModel} is not on this server. Available: ${models.join(', ')}.` });
  } else {
    try {
      const answer = await describeLocalImage(s, { data: await wordPicture('WIKI'), mime: 'image/png' }, 'What single word is written in this image? Reply with just the word.');
      if (/wiki/i.test(answer)) {
        steps.push({ label: visionLabel, status: 'passed', optional: true, detail: `${visionModel} can read images, so photos and scanned PDFs work.` });
      } else {
        steps.push({
          label: visionLabel,
          status: 'failed',
          optional: true,
          detail: `${visionModel} could not read a test image (it answered "${answer.slice(0, 60)}"). Text files, PDFs and Word documents still work. For photos, set a vision model such as qwen2.5vl.`,
        });
      }
    } catch (e: any) {
      steps.push({ label: visionLabel, status: 'failed', optional: true, detail: `${e.message} Text files, PDFs and Word documents still work.` });
    }
  }

  return { ok: steps.every((st) => st.status === 'passed' || st.optional), steps, models };
}
