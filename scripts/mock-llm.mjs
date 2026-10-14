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
  if (!scenario) {
    message.content = 'The wiki does not cover that yet.';
  } else if (toolTurns < scenario.steps.length) {
    const step = scenario.steps[toolTurns];
    message.tool_calls = [
      { id: `call_${toolTurns}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } },
    ];
  } else {
    message.content = scenario.reply;
  }
  return {
    id: 'mock',
    object: 'chat.completion',
    model: body.model,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
  };
}

export function startMock(port = 4555) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const out = respond(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] || 4555);
  await startMock(port);
  console.log(`Mock model listening on http://127.0.0.1:${port}/v1`);
}
