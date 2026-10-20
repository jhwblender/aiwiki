// A scripted OpenAI-compatible chat server for testing the agent without a real model.
// Each scenario is picked by a keyword in the latest user message and replays a fixed
// sequence of tool calls, one per model turn, then a final text reply.
//
// Run on its own:  node scripts/mock-llm.mjs 4555
// Then set LOCAL_LLM_BASE_URL=http://127.0.0.1:4555/v1

import http from 'node:http';
import { pathToFileURL } from 'node:url';

const SCENARIOS = [
  {
    keyword: 'vpn',
    steps: [
      { name: 'search_pages', args: { query: 'VPN' } },
      { name: 'read_page', args: { path: 'systems/onboarding' } },
      {
        name: 'replace_in_page',
        args: {
          path: 'systems/onboarding',
          old_text: 'Request VPN access from IT before your first day.',
          new_text: 'Request VPN access through the IT portal before your first day.',
          summary: 'VPN requests now go through the IT portal',
        },
      },
    ],
    reply: 'I proposed an update to [[systems/onboarding]]: VPN requests now go through the IT portal. It is waiting for review.',
  },
  {
    keyword: 'dashboard',
    steps: [
      { name: 'read_page', args: { path: 'systems/onboarding' } },
      {
        name: 'replace_in_page',
        args: {
          path: 'systems/onboarding',
          old_text: 'Badge access is handled by facilities.',
          new_text: 'Badge access is handled by facilities. Collect your badge from reception on day one.',
          summary: 'Onboarding: badge pickup and dashboard link',
        },
      },
      {
        name: 'append_to_page',
        args: {
          path: 'systems/onboarding',
          text: '## Dashboards\n\nThe monitoring dashboard lives at https://grafana.example.internal. Bookmark it.',
          summary: 'Onboarding: badge pickup and dashboard link',
        },
      },
    ],
    reply: 'I proposed two changes to [[systems/onboarding]]: badge pickup and a new Dashboards section.',
  },
  {
    keyword: 'rotation',
    steps: [
      {
        name: 'replace_in_page',
        args: {
          path: 'systems/onboarding',
          old_text: 'Ask your manager to add you to both.',
          new_text: 'Ask your manager to add you to both. The rotation changes over on Mondays.',
          summary: 'On-call rotation changes on Mondays',
        },
      },
    ],
    reply: 'I proposed a note about the rotation handover on [[systems/onboarding]].',
  },
  {
    // calls tools the way small local models sometimes do: wrong case, near-miss argument names
    keyword: 'parking',
    steps: [
      { name: 'Read_Page', args: { page: 'systems/onboarding' } },
      { name: 'delete_page', args: { path: 'systems/onboarding' } },
      {
        name: 'appendToPage',
        args: { page_path: 'systems/onboarding', content: 'Staff parking is in lot B.', description: 'Add parking info' },
      },
    ],
    reply: 'I proposed a note about parking on [[systems/onboarding]].',
  },
  {
    // replays a real model's mistake: fixes the text in place, then also appends a "correction" copy
    keyword: 'whoops',
    steps: [
      {
        name: 'replace_in_page',
        args: {
          path: 'systems/onboarding',
          old_text: 'Mondays and Fridays are remote work days.',
          new_text: 'Every Monday is remote.',
          summary: 'Correct the remote days',
        },
      },
      {
        name: 'append_to_page',
        args: { path: 'systems/onboarding', text: '## Work schedule correction\n\nEvery Monday is remote.', summary: 'Correct the remote days' },
      },
    ],
    reply: 'I corrected the remote days.',
  },
  {
    keyword: 'remote work days',
    steps: [
      {
        name: 'append_to_page',
        args: { path: 'systems/onboarding', text: '## Work schedule\n\nMondays and Fridays are remote work days.', summary: 'Add remote days' },
      },
    ],
    reply: 'I proposed the remote work days.',
  },
  {
    // a correction in the same chat; only works if the chat's own pending suggestion is visible
    keyword: 'tuesday',
    steps: [
      { name: 'read_page', args: { path: 'systems/onboarding' } },
      {
        name: 'replace_in_page',
        args: {
          path: 'systems/onboarding',
          old_text: 'Team lunch is on Mondays.',
          new_text: 'Team lunch is on Tuesdays.',
          summary: 'Team lunch is on Tuesdays',
        },
      },
    ],
    reply: 'I updated my suggestion: team lunch is on Tuesdays.',
  },
  {
    keyword: 'lunch',
    steps: [
      {
        name: 'append_to_page',
        args: { path: 'systems/onboarding', text: 'Team lunch is on Mondays.', summary: 'Add the team lunch day' },
      },
    ],
    reply: 'I proposed adding the team lunch day to [[systems/onboarding]].',
  },
  {
    // reports whether read_page showed pending suggestions from others
    keyword: 'anything pending',
    steps: [{ name: 'read_page', args: { path: 'systems/onboarding' } }],
    reply: (toolText) => (toolText.includes('Pending suggestions from others') ? 'PENDING-SEEN' : 'PENDING-NOT-SEEN'),
  },
  {
    keyword: 'backup',
    steps: [
      { name: 'search_pages', args: { query: 'backup' } },
      {
        name: 'create_page',
        args: {
          path: 'systems/backup-policy',
          content: '# Backup policy\n\nFile servers are backed up nightly at 01:00 and kept for 30 days.\n\nRestores are requested through the IT portal.',
          summary: 'New page: backup policy',
        },
      },
    ],
    reply: 'There was no backup page, so I proposed a new one at [[systems/backup-policy]].',
  },
];

// Requests the Anthropic route received, for the e2e script to inspect
export const anthropicRequests = [];

// Shown for anything outside the scenarios, so nobody mistakes the mock for a real model
const NOT_A_MODEL =
  'This is the scripted test model, not a real AI, so it can only run its demo scenarios ' +
  '(try mentioning the VPN, the dashboard, the rotation, parking, team lunch or a backup policy). Connect a real model on the Settings page.';

// Tool results in either format, so a scenario reply can depend on what the tools returned
function toolTexts(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') out.push(String(m.content));
    if (Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_result') out.push(String(b.content));
  }
  return out.join('\n');
}

function replyFor(scenario, toolText) {
  return typeof scenario.reply === 'function' ? scenario.reply(toolText) : scenario.reply;
}

function pick(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = String(lastUser?.content ?? '').toLowerCase();
  return SCENARIOS.find((s) => text.includes(s.keyword));
}

function respond(body) {
  const messages = body.messages ?? [];
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
  const toolTurns = messages.slice(lastUserIdx + 1).filter((m) => m.role === 'assistant').length;
  const scenario = pick(messages);
  const message = { role: 'assistant', content: '' };
  const offered = (body.tools ?? []).map((t) => t.function?.name);
  if (offered.length === 1 && offered[0] === 'ping') {
    // the Settings connection test
    message.tool_calls = [{ id: 'call_ping', type: 'function', function: { name: 'ping', arguments: '{}' } }];
  } else if (!scenario) {
    message.content = /reply with the single word/i.test(String(messages.at(-1)?.content)) ? 'ready' : NOT_A_MODEL;
  } else if (toolTurns < scenario.steps.length) {
    const step = scenario.steps[toolTurns];
    message.tool_calls = [
      { id: `call_${toolTurns}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } },
    ];
  } else {
    message.content = replyFor(scenario, toolTexts(messages));
  }
  return {
    id: 'mock',
    object: 'chat.completion',
    model: body.model,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
  };
}

// The same scenarios in the Anthropic Messages format. Every reply carries a signed thinking
// block, and the request is checked the way the real API checks it: earlier assistant turns
// must come back with their blocks unchanged, and a turn's tool results share one user message.
function textOf(content) {
  return typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function validateAnthropic(body) {
  const msgs = body.messages ?? [];
  if (msgs[0]?.role !== 'user') return 'messages: first message must use the "user" role';
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use')) {
      const thinking = m.content.find((b) => b.type === 'thinking');
      if (!thinking || !String(thinking.signature).startsWith('sig-')) {
        return `messages.${i}.content: thinking blocks in the latest assistant turn must be passed back unmodified`;
      }
      const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
      const next = msgs[i + 1];
      const results = Array.isArray(next?.content) ? next.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : [];
      if (ids.some((id) => !results.includes(id))) {
        return `messages.${i + 1}: tool_use ids were found without tool_result blocks immediately after`;
      }
    }
  }
  return null;
}

function respondAnthropic(body) {
  const error = validateAnthropic(body);
  if (error) return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: error } } };
  const msgs = body.messages;
  const lastUserText = [...msgs].reverse().find((m) => m.role === 'user' && textOf(m.content))?.content;
  const lastUserIdx = msgs.findLastIndex((m) => m.role === 'user' && textOf(m.content));
  const turns = msgs.slice(lastUserIdx + 1).filter((m) => m.role === 'assistant').length;
  const scenario = SCENARIOS.find((sc) => textOf(lastUserText ?? '').toLowerCase().includes(sc.keyword));
  const thinking = { type: 'thinking', thinking: '', signature: `sig-${turns}` };
  let content;
  let stop = 'end_turn';
  if (!scenario) content = [thinking, { type: 'text', text: NOT_A_MODEL }];
  else if (turns < scenario.steps.length) {
    const step = scenario.steps[turns];
    content = [thinking, { type: 'tool_use', id: `toolu_${turns}`, name: step.name, input: step.args }];
    stop = 'tool_use';
  } else content = [thinking, { type: 'text', text: replyFor(scenario, toolTexts(msgs)) }];
  return {
    status: 200,
    body: {
      id: `msg_${turns}`, type: 'message', role: 'assistant', model: body.model, content,
      stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
    },
  };
}

export function startMock(port = 4555) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status, out) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
      if (req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
        const body = JSON.parse(raw || '{}');
        const out = respondAnthropic(body);
        anthropicRequests.push({ beta: req.headers['anthropic-beta'], body, status: out.status });
        send(out.status, out.body);
        return;
      }
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        send(200, { object: 'list', data: [{ id: 'mock', object: 'model' }] });
        return;
      }
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      send(200, respond(JSON.parse(raw || '{}')));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] || 4555);
  await startMock(port);
  console.log(`Mock model listening on http://127.0.0.1:${port}/v1`);
}
