import { db } from './db';

// Settings saved from the Settings page win over .env.local, which stays the default.

// visionModel reads photos and scanned pages; blank means the main model does it
export type LocalModelSettings = { baseUrl: string; model: string; apiKey: string; visionModel: string };

const DEFAULT_LOCAL_MODEL = 'qwen2.5:14b-instruct';

function get(key: string): string | null {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

function set(key: string, value: string) {
  db().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function cleanBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function localModelSettings(): LocalModelSettings {
  return {
    baseUrl: cleanBaseUrl(get('local.baseUrl') ?? process.env.LOCAL_LLM_BASE_URL ?? ''),
    model: (get('local.model') ?? process.env.LOCAL_LLM_MODEL ?? '') || DEFAULT_LOCAL_MODEL,
    apiKey: get('local.apiKey') ?? process.env.LOCAL_LLM_API_KEY ?? '',
    visionModel: get('local.visionModel') ?? process.env.LOCAL_LLM_VISION_MODEL ?? '',
  };
}

// apiKey: undefined keeps the saved key, '' clears it
export function saveLocalModelSettings(input: { baseUrl: string; model: string; apiKey?: string; visionModel?: string }) {
  const baseUrl = cleanBaseUrl(input.baseUrl);
  if (baseUrl && !/^https?:\/\/[^\s/]+/i.test(baseUrl)) throw new Error('The server address must start with http:// or https://');
  set('local.baseUrl', baseUrl);
  set('local.model', input.model.trim());
  if (input.visionModel !== undefined) set('local.visionModel', input.visionModel.trim());
  if (input.apiKey !== undefined) set('local.apiKey', input.apiKey.trim());
}

// The quiet time after a chat reply: background filing waits this long before claiming its next
// job, so the machine stays with the person reading and typing. Resume, Try now or a new chat cut
// the wait short.
export function chatHoldSeconds(): number {
  const n = Number(get('queue.chatHoldSeconds'));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 3600) : 300;
}

export function saveChatHoldSeconds(seconds: number): number {
  const n = Math.floor(Number(seconds));
  if (!(n >= 0 && n <= 3600)) throw new Error('The chat hold must be a number of seconds from 0 to 3600.');
  set('queue.chatHoldSeconds', String(n));
  return n;
}
