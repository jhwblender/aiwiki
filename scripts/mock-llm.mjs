// A scripted OpenAI-compatible chat server for testing the agent without a real model.
// Each scenario is picked by a keyword in the latest user message and replays a fixed
// sequence of tool calls, one per model turn, then a final text reply.
//
// Run on its own:  node scripts/mock-llm.mjs 4555
// Then set LOCAL_LLM_BASE_URL=http://127.0.0.1:4555/v1

import http from 'node:http';
import { pathToFileURL } from 'node:url';

// A librarian survey line, read back by the tidy scenario
const surveyLine = (text, re) => text.match(re) ?? [];

const SCENARIOS = [
  {
    // a filing plan for the test folder: one line per folder
    keyword: 'watched folder "plan share"',
    steps: [],
    reply: '(top level) | file | documents\nRaw/ | skip | raw sensor data\nCaptures | sample | one folder per capture run\nNowhere/ | skip | not a real folder',
  },
  {
    // a long file: part 1 must not include the end, and read_file_part fetches the last part
    keyword: 'skim this file',
    steps: [{ name: 'read_file_part', args: (text) => ({ file: 'long-manual.txt', part: Number(text.match(/only part 1 of (\d+)/)?.[1] ?? 0) }) }],
    reply: (tools) => (/part \d+ of \d+/.test(tools) && tools.includes('PART-TWO-MARKER') ? 'PARTS-OK' : 'PARTS-NOT-OK'),
  },
  {
    // an organise run: gives the first section without a summary one, tries to edit page text (which
    // organising may not do), and reports whether it saw the structure and the watched folder map
    keyword: 'organise the whole wiki',
    steps: [
      {
        name: 'set_summary',
        args: (text) => ({ path: text.match(/^- (\S+) has no (?:summary|page of its own)/m)?.[1] ?? 'none', summary: 'Everything about this part of the wiki.', reason: 'Say what belongs here' }),
      },
      { name: 'replace_in_page', args: { path: 'index', old_text: 'Welcome', new_text: 'Hello', summary: 'Rename' } },
      { name: 'survey_section', args: { section: '*' } },
    ],
    reply: (tools) =>
      /Current structure \(generated/.test(tools) && tools.includes('"Lib share" (2 files, none filed yet)') && /Printers\/ \(1 file, none filed yet\)/.test(tools) &&
      tools.includes('organising only arranges pages') && /Proposed (the summary|a new section page)/.test(tools)
        ? 'WHOLE-SURVEY-SEEN'
        : 'WHOLE-SURVEY-NOT-SEEN',
  },
  {
    keyword: 'move the kb folder',
    steps: [{ name: 'move_page', args: { path: 'kb', new_path: 'help', summary: 'Help pages belong under help' } }],
    reply: 'I proposed moving the kb pages under help.',
  },
  {
    // a librarian tidy run: merges the first duplicate pair, adds the first missing overview and fixes a broken link.
    // First in the list because the survey can mention words other scenarios listen for.
    keyword: 'librarian pass over',
    steps: [
      { name: 'read_page', args: (text) => ({ path: surveyLine(text, /^- (\S+) and (\S+): /m)[2] ?? 'none' }) },
      {
        name: 'append_to_page',
        args: (text) => ({ path: surveyLine(text, /^- (\S+) and (\S+): /m)[1] ?? 'none', text: 'Colour printing needs a code from reception.', summary: 'Merge the duplicate printing page' }),
      },
      { name: 'remove_page', args: (text) => ({ path: surveyLine(text, /^- (\S+) and (\S+): /m)[2] ?? 'none', summary: 'Merged into the printers page' }) },
      {
        name: 'create_page',
        args: (text) => {
          const p = surveyLine(text, /^- (\S+) has \d+ pages? under it but no page of its own/m)[1] ?? 'none';
          return { path: p, content: `# Overview\n\nWhat the pages under ${p} cover.`, summary: 'Add an overview page' };
        },
      },
      {
        name: 'replace_in_page',
        args: (text) => {
          const [, page, raw, meant] = surveyLine(text, /^- (\S+) links to "([^"]+)", which does not exist; probably meant (\S+)/m);
          return { path: page ?? 'none', old_text: `[[${raw}]]`, new_text: `[[${meant}]]`, summary: 'Fix a broken link' };
        },
      },
    ],
    reply: (tools) => (tools.includes('reached its limit') ? 'Tidied what I could; the broken link fix went over the limit.' : 'Tidied the section.'),
  },
  {
    keyword: 'tidy the kb section',
    steps: [{ name: 'survey_section', args: { area: 'kb' } }],
    reply: (tools) => (/kb\/printers and kb\/printing/.test(tools) && tools.includes('probably meant kb/printers') ? 'SURVEY-SEEN' : 'SURVEY-NOT-SEEN'),
  },
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
    keyword: 'tidy the handbook',
    steps: [{ name: 'move_page', args: { from: 'team/handbook', to: 'guides/handbook', summary: 'Handbooks belong under guides' } }],
    reply: 'I proposed moving the handbook to [[guides/handbook]].',
  },
  {
    keyword: 'merge first week',
    steps: [
      {
        name: 'append_to_page',
        args: { path: 'team/onboarding', text: '## First week\n\nShadow the on-call engineer for the whole week.', summary: 'Merge the first week page into onboarding' },
      },
      { name: 'remove_page', args: { path: 'team/onboarding/first-week', summary: 'Merge the first week page into onboarding' } },
    ],
    reply: 'I proposed merging the first week page into [[team/onboarding]].',
  },
  {
    keyword: 'move it again',
    steps: [{ name: 'move_page', args: { path: 'team/handbook', new_path: 'policies/handbook', summary: 'Handbooks are policies' } }],
    reply: 'I changed my suggestion: move the handbook to policies instead.',
  },
  {
    // claims a move without calling the tool, then calls it after the automatic check
    keyword: 'pretend to move',
    steps: [
      { text: 'I have proposed moving the handbook to guides/handbook.' },
      { name: 'move_page', args: { path: 'policies/handbook', new_path: 'manuals/handbook', summary: 'Handbooks belong under manuals' } },
    ],
    reply: 'Done: the move is waiting for review.',
  },
  {
    // keeps claiming without ever calling a tool
    keyword: 'only pretend',
    steps: [{ text: 'I have proposed moving the handbook.' }, { text: 'I have proposed moving the handbook.' }],
    reply: 'I have proposed moving the handbook.',
  },
  {
    // files every FACT line it finds in the attached files, proving extraction reached the model
    keyword: 'file this',
    steps: [
      {
        name: 'append_to_page',
        args: (text) => ({ path: 'team/onboarding', text: factsIn(text).join(' ') || 'FILE-NOT-SEEN', summary: 'Add facts from the attached files' }),
      },
    ],
    reply: 'I proposed adding what the attached files say to [[team/onboarding]].',
  },
  {
    // cites the file in the page text first, as a real model did, then writes it plainly
    keyword: 'where the keys are',
    steps: [
      { name: 'append_to_page', args: { path: 'team/onboarding', text: 'Based on the "keys.txt" file, the spare keys are in the blue cabinet.', summary: 'Spare keys location' } },
      { name: 'append_to_page', args: { path: 'team/onboarding', text: 'The spare keys are in the blue cabinet.', summary: 'Spare keys location' } },
    ],
    reply: 'I proposed where the spare keys are, from keys.txt.',
  },
  {
    // the background queue's default instruction; files the same way as "file this"
    keyword: 'file the information from the attached document',
    steps: [
      {
        name: 'append_to_page',
        args: (text) => ({
          path: 'team/onboarding',
          text: factsIn(text).join(' ') || 'FILE-NOT-SEEN',
          summary: /Path in folder: .*\n[\s\S]*Folder outline/.test(text) ? 'Add facts from a document (location seen)' : 'Add facts from a document',
        }),
      },
    ],
    reply: 'I proposed adding what the document says to [[team/onboarding]].',
  },
  {
    // applies a changed document: replaces what it no longer says with what it now says
    keyword: 'apply the update',
    steps: [
      {
        name: 'replace_in_page',
        args: (text) => ({
          path: 'team/onboarding',
          old_text: text.match(/No longer says:\n\s+FACT: ([^\n]+)/)?.[1] ?? 'CHANGE-NOT-SEEN',
          new_text: text.match(/Now says:\n\s+FACT: ([^\n]+)/)?.[1] ?? 'CHANGE-NOT-SEEN',
          summary: 'Update from the new version of the parts list',
        }),
      },
    ],
    reply: 'I proposed updating the page for the new version of the parts list.',
  },
  {
    keyword: 'add a canteen section',
    steps: [{ name: 'append_to_page', args: { path: 'team/onboarding', text: '## Canteen\n\nThe canteen opens at 11:30.', summary: 'Add the canteen hours' } }],
    reply: 'I proposed a canteen section on [[team/onboarding]].',
  },
  {
    // moves a pending addition from this chat to a new page
    keyword: 'move the canteen section',
    steps: [
      { name: 'read_page', args: { path: 'team/onboarding' } },
      { name: 'replace_in_page', args: { path: 'team/onboarding', old_text: '## Canteen\n\nThe canteen opens at 11:30.', new_text: '', summary: 'Move the canteen hours' } },
      { name: 'create_page', args: { path: 'facilities/canteen', content: '# Canteen\n\nThe canteen opens at 11:30.', summary: 'Move the canteen hours' } },
    ],
    reply: 'I moved the canteen section to its own page, [[facilities/canteen]].',
  },
  {
    keyword: 'suggest a gym page',
    steps: [{ name: 'create_page', args: { path: 'facilities/gym', content: '# Gym\n\nThe gym is in the basement.', summary: 'New gym page' } }],
    reply: 'I proposed a gym page.',
  },
  {
    keyword: 'move the gym page',
    steps: [{ name: 'move_page', args: { path: 'facilities/gym', new_path: 'perks/gym', summary: 'The gym is a perk' } }],
    reply: 'I moved the suggested gym page under perks.',
  },
  {
    keyword: 'relocate the perks gym page',
    steps: [{ name: 'move_page', args: { path: 'perks/gym', new_path: 'misc/gym', summary: 'Somewhere else' } }],
    reply: 'Done.',
  },
  {
    // answers from an original document that the wiki does not cover
    keyword: 'what does the manual say',
    steps: [
      { name: 'search_documents', args: { query: 'torque motor screws' } },
      { name: 'read_document', args: (_text, tools) => ({ document: tools.match(/document (\d+)/)?.[1] ?? 'none', part: 1 }) },
    ],
    reply: (tools) => (tools.includes('2 Nm') ? 'DOC-SEEN: 2 Nm, from the manual (not in the wiki yet)' : 'DOC-NOT-SEEN'),
  },
  {
    keyword: 'add the torque spec',
    steps: [
      { name: 'search_documents', args: { query: 'torque' } },
      { name: 'read_document', args: (_text, tools) => ({ document: tools.match(/document (\d+)/)?.[1] ?? 'none' }) },
      { name: 'append_to_page', args: { path: 'team/onboarding', text: 'Motor screws are torqued to 2 Nm.', summary: 'Add the motor screw torque' } },
    ],
    reply: 'I proposed adding the torque spec to [[team/onboarding]].',
  },
  {
    keyword: 'search my notes',
    steps: [
      { name: 'search_documents', args: { query: 'pineapple' } },
      { name: 'read_document', args: (_text, tools) => ({ document: tools.match(/document (\d+)/)?.[1] ?? 'none' }) },
    ],
    reply: (tools) => (tools.includes('PINEAPPLE') ? 'PERSONAL-SEEN' : 'PERSONAL-NOT-SEEN'),
  },
  {
    // reads a personal document, then tries to put it into the wiki
    keyword: 'put my notes in the wiki',
    steps: [
      { name: 'search_documents', args: { query: 'pineapple' } },
      { name: 'read_document', args: (_text, tools) => ({ document: tools.match(/document (\d+)/)?.[1] ?? 'none' }) },
      { name: 'append_to_page', args: { path: 'team/onboarding', text: 'The code word is PINEAPPLE.', summary: 'Add the code word' } },
    ],
    reply: 'Done.',
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

// The agent's automatic follow-up when a reply claims a change without calling a tool
function isNudge(m) {
  return typeof m.content === 'string' && m.content.startsWith('(Automatic check)');
}

function replyFor(scenario, toolText) {
  return typeof scenario.reply === 'function' ? scenario.reply(toolText) : scenario.reply;
}

function pick(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user' && !isNudge(m));
  const text = String(lastUser?.content ?? '').toLowerCase();
  return SCENARIOS.find((s) => text.includes(s.keyword));
}

// Images arrive as image_url parts (OpenAI format) or image blocks (Anthropic format)
function hasImage(messages) {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url' || p.type === 'image'),
  );
}

function describeMockImage(messages) {
  const prompt = messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join(' ');
  if (/what single word/i.test(prompt)) return 'WIKI';
  const page = prompt.match(/page (\d+) of \d+ of a scanned document/i);
  if (page) return `FACT: Scanned page ${page[1]} says the generator is tested monthly.`;
  return 'A photo of a server rack. FACT: The rack label reads RACK-7.';
}

// Every "FACT: ..." line in the attached files, so the mock can prove it read them
function factsIn(text) {
  return [...String(text).matchAll(/FACT: ([^\n]+)/g)].map((m) => m[1].trim());
}

function respond(body) {
  const messages = body.messages ?? [];
  if (hasImage(messages)) {
    return { id: 'mock', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: describeMockImage(messages) }, finish_reason: 'stop' }] };
  }
  const lastUserIdx = messages.findLastIndex((m) => m.role === 'user' && !isNudge(m));
  const toolTurns = messages.slice(lastUserIdx + 1).filter((m) => m.role === 'assistant').length;
  const scenario = pick(messages);
  const message = { role: 'assistant', content: '' };
  const offered = (body.tools ?? []).map((t) => t.function?.name);
  if (offered.length === 1 && offered[0] === 'ping') {
    // the Settings connection test
    message.tool_calls = [{ id: 'call_ping', type: 'function', function: { name: 'ping', arguments: '{}' } }];
  } else if (!scenario) {
    message.content = /reply with the single word/i.test(String(messages.at(-1)?.content)) ? 'ready' : NOT_A_MODEL;
  } else if (toolTurns < scenario.steps.length && scenario.steps[toolTurns].text) {
    message.content = scenario.steps[toolTurns].text; // a reply with no tool call
  } else if (toolTurns < scenario.steps.length) {
    const step = scenario.steps[toolTurns];
    const args = typeof step.args === 'function' ? step.args(String(messages[lastUserIdx]?.content ?? ''), toolTexts(messages)) : step.args;
    message.tool_calls = [{ id: `call_${toolTurns}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(args) } }];
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
  if (hasImage(msgs)) {
    return {
      status: 200,
      body: {
        id: 'msg_img', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: describeMockImage(msgs) }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
      },
    };
  }
  const lastUserText = [...msgs].reverse().find((m) => m.role === 'user' && textOf(m.content) && !isNudge(m))?.content;
  const lastUserIdx = msgs.findLastIndex((m) => m.role === 'user' && textOf(m.content) && !isNudge(m));
  const turns = msgs.slice(lastUserIdx + 1).filter((m) => m.role === 'assistant').length;
  const scenario = SCENARIOS.find((sc) => textOf(lastUserText ?? '').toLowerCase().includes(sc.keyword));
  const thinking = { type: 'thinking', thinking: '', signature: `sig-${turns}` };
  let content;
  let stop = 'end_turn';
  if (!scenario) content = [thinking, { type: 'text', text: NOT_A_MODEL }];
  else if (turns < scenario.steps.length && scenario.steps[turns].text) content = [thinking, { type: 'text', text: scenario.steps[turns].text }];
  else if (turns < scenario.steps.length) {
    const step = scenario.steps[turns];
    const args = typeof step.args === 'function' ? step.args(textOf(lastUserText ?? ''), toolTexts(msgs)) : step.args;
    content = [thinking, { type: 'tool_use', id: `toolu_${turns}`, name: step.name, input: args }];
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
      // "slowly" in a message makes each answer take a moment, to see progress in the UI
      const body = JSON.parse(raw || '{}');
      const slow = (body.messages ?? []).some((m) => typeof m.content === 'string' && m.role === 'user' && /slowly/i.test(m.content));
      setTimeout(() => send(200, respond(body)), slow ? 1500 : 0);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] || 4555);
  await startMock(port);
  console.log(`Mock model listening on http://127.0.0.1:${port}/v1`);
}
