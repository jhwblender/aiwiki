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
