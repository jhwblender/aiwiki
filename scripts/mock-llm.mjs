// A scripted OpenAI-compatible chat server for testing the agent without a real model.
// Each scenario is picked by a keyword in the latest user message and replays a fixed
// sequence of tool calls, one per model turn, then a final text reply.
//
// Run on its own:  node scripts/mock-llm.mjs 4555
// Then set LOCAL_LLM_BASE_URL=http://127.0.0.1:4555/v1
//
// The scenarios edit the seeded guide page (guide/basics) and, after the e2e move
// test, the page it became (docs/basics). They only ever propose; nothing is written
// until a person approves.

import http from 'node:http';
import { pathToFileURL } from 'node:url';

// A librarian survey line, read back by the tidy scenario
const surveyLine = (text, re) => text.match(re) ?? [];

// The guide page is the subject of most scenarios
const GUIDE = 'guide/basics';
const GUIDE_MOVED = 'docs/basics';

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
    steps: [{ name: 'read_file_part', args: (text) => ({ file: 'long-notes.txt', part: Number(text.match(/only part 1 of (\d+)/)?.[1] ?? 0) }) }],
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
      /Current structure \(generated/.test(tools) && tools.includes('"Docs share" (2 documents, none filed yet)') && /Pages\/ \(1 document, none filed yet\)/.test(tools) &&
      tools.includes('organising only arranges pages') && /Proposed (the summary|a new section page)/.test(tools)
        ? 'WHOLE-SURVEY-SEEN'
        : 'WHOLE-SURVEY-NOT-SEEN',
  },
  {
    keyword: 'move the notes folder',
    steps: [{ name: 'move_page', args: { path: 'notes', new_path: 'help', summary: 'Note pages belong under help' } }],
    reply: 'I proposed moving the notes pages under help.',
  },
  {
    // a librarian tidy run: merges the first duplicate pair, adds the first missing overview and fixes a broken link.
    // First in the list because the survey can mention words other scenarios listen for.
    keyword: 'librarian pass over',
    steps: [
      { name: 'read_page', args: (text) => ({ path: surveyLine(text, /^- (\S+) and (\S+): /m)[2] ?? 'none' }) },
      {
        name: 'append_to_page',
        args: (text) => ({ path: surveyLine(text, /^- (\S+) and (\S+): /m)[1] ?? 'none', text: 'Renaming follows the links with the move action.', summary: 'Merge the duplicate pages page' }),
      },
      { name: 'remove_page', args: (text) => ({ path: surveyLine(text, /^- (\S+) and (\S+): /m)[2] ?? 'none', summary: 'Merged into the pages page' }) },
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
    keyword: 'tidy the notes section',
    steps: [{ name: 'survey_section', args: { area: 'notes' } }],
    reply: (tools) => (/notes\/pages and notes\/writing/.test(tools) && tools.includes('probably meant notes/pages') ? 'SURVEY-SEEN' : 'SURVEY-NOT-SEEN'),
  },
  {
    keyword: 'simple markdown',
    steps: [
      { name: 'search_pages', args: { query: 'markdown' } },
      { name: 'read_page', args: { path: GUIDE } },
      {
        name: 'replace_in_page',
        args: {
          path: GUIDE,
          old_text: 'Pages are simple markdown.',
          new_text: 'Pages keep to simple markdown, and sections start with a heading.',
          summary: 'Say pages keep to simple markdown',
        },
      },
    ],
    reply: 'I proposed an update to [[guide/basics]]: pages keep to simple markdown, and sections start with a heading. It is waiting for review.',
  },
  {
    keyword: 'where facts come from',
    steps: [
      { name: 'read_page', args: { path: GUIDE } },
      {
        name: 'replace_in_page',
        args: {
          path: GUIDE,
          old_text: 'Drop a file into the chat and the assistant will read it and suggest edits for you to approve.',
          new_text: 'Drop a file into the chat and the assistant will read it and suggest edits for you to approve. It will place its facts on pages.',
          summary: 'Guide: the opening line and a Sources section',
        },
      },
      {
        name: 'append_to_page',
        args: {
          path: GUIDE,
          text: '## Sources\n\nThe sources list records where each new fact came from.',
          summary: 'Guide: the opening line and a Sources section',
        },
      },
    ],
    reply: 'I proposed two changes to [[guide/basics]]: the opening line and a new Sources section.',
  },
  {
    keyword: 'review list',
    steps: [
      {
        name: 'replace_in_page',
        args: {
          path: GUIDE,
          old_text: 'This page is only a starting point, so change or delete it as you like.',
          new_text: 'This page is only a starting point, so change or delete it as you like. The review list on each page decides what is published.',
          summary: 'Say what the review list does',
        },
      },
    ],
    reply: 'I proposed a note about the review list on [[guide/basics]].',
  },
  {
    // calls tools the way small local models sometimes do: wrong case, near-miss argument names
    keyword: 'house style',
    steps: [
      { name: 'Read_Page', args: { page: GUIDE } },
      { name: 'delete_page', args: { path: GUIDE } },
      {
        name: 'appendToPage',
        args: { page_path: GUIDE, content: 'The house style asks for one blank line between paragraphs.', description: 'Add the house style' },
      },
    ],
    reply: 'I proposed a note about the house style on [[guide/basics]].',
  },
  {
    // replays a real model's mistake: fixes the text in place, then also appends a "correction" copy
    keyword: 'whoops',
    steps: [
      {
        name: 'replace_in_page',
        args: {
          path: GUIDE,
          old_text: 'Every page ends with a list of related pages.',
          new_text: 'Only summary pages end with a list of related pages.',
          summary: 'Narrow the related pages rule',
        },
      },
      {
        name: 'append_to_page',
        args: { path: GUIDE, text: '## Correction\n\nOnly summary pages end with a list of related pages.', summary: 'Narrow the related pages rule' },
      },
    ],
    reply: 'I corrected the related pages rule.',
  },
  {
    keyword: 'list of related pages',
    steps: [
      {
        name: 'append_to_page',
        args: { path: GUIDE, text: '## Related pages\n\nEvery page ends with a list of related pages.', summary: 'Add the related pages rule' },
      },
    ],
    reply: 'I proposed the related pages rule.',
  },
  {
    // a correction in the same chat; only works if the chat's own pending suggestion is visible
    keyword: 'tuesday',
    steps: [
      { name: 'read_page', args: { path: GUIDE } },
      {
        name: 'replace_in_page',
        args: {
          path: GUIDE,
          old_text: 'The guide is reviewed on Mondays.',
          new_text: 'The guide is reviewed on Tuesdays.',
          summary: 'The review day is Tuesday',
        },
      },
    ],
    reply: 'I updated my suggestion: the guide is reviewed on Tuesdays.',
  },
  {
    keyword: 'review day',
    steps: [
      {
        name: 'append_to_page',
        args: { path: GUIDE, text: 'The guide is reviewed on Mondays.', summary: 'Add the review day' },
      },
    ],
    reply: 'I proposed adding the review day to [[guide/basics]].',
  },
  {
    // reports whether read_page showed pending suggestions from others
    keyword: 'anything pending',
    steps: [{ name: 'read_page', args: { path: GUIDE } }],
    reply: (toolText) => (toolText.includes('Pending suggestions from others') ? 'PENDING-SEEN' : 'PENDING-NOT-SEEN'),
  },
  {
    keyword: 'tidy the notebook',
    steps: [{ name: 'move_page', args: { from: 'pages/notebook', to: 'guides/notebook', summary: 'Notebooks belong under guides' } }],
    reply: 'I proposed moving the notebook to [[guides/notebook]].',
  },
  {
    keyword: 'merge the details',
    steps: [
      {
        name: 'append_to_page',
        args: { path: GUIDE_MOVED, text: '## Details\n\nEarly drafts are kept in the history of the guide.', summary: 'Merge the details page into the guide' },
      },
      { name: 'remove_page', args: { path: 'docs/basics/details', summary: 'Merge the details page into the guide' } },
    ],
    reply: 'I proposed merging the details page into [[docs/basics]].',
  },
  {
    keyword: 'move it again',
    steps: [{ name: 'move_page', args: { path: 'pages/notebook', new_path: 'style/notebook', summary: 'Notebooks are style notes' } }],
    reply: 'I changed my suggestion: move the notebook to style instead.',
  },
  {
    // claims a move without calling the tool, then calls it after the automatic check
    keyword: 'pretend to move',
    steps: [
      { text: 'I have proposed moving the notebook to guides/notebook.' },
      { name: 'move_page', args: { path: 'style/notebook', new_path: 'drafts/notebook', summary: 'Notebooks belong under drafts' } },
    ],
    reply: 'Done: the move is waiting for review.',
  },
  {
    // keeps claiming without ever calling a tool
    keyword: 'only pretend',
    steps: [{ text: 'I have proposed moving the notebook.' }, { text: 'I have proposed moving the notebook.' }],
    reply: 'I have proposed moving the notebook.',
  },
  {
    // files every FACT line it finds in the attached files, proving extraction reached the model
    keyword: 'file this',
    steps: [
      {
        name: 'append_to_page',
        args: (text) => ({ path: GUIDE_MOVED, text: factsIn(text).join(' ') || 'FILE-NOT-SEEN', summary: 'Add facts from the attached files' }),
      },
    ],
    reply: 'I proposed adding what the attached files say to [[docs/basics]].',
  },
  {
    // cites the file in the page text first, as a real model did, then writes it plainly
    keyword: 'what the checklist says',
    steps: [
      { name: 'append_to_page', args: { path: GUIDE_MOVED, text: 'Based on the "checklist.txt" file, the review checklist says approve one change at a time.', summary: 'What the checklist says' } },
      { name: 'append_to_page', args: { path: GUIDE_MOVED, text: 'The review checklist says approve one change at a time.', summary: 'What the checklist says' } },
    ],
    reply: 'I proposed what the checklist says, from checklist.txt.',
  },
  {
    // the background queue's default instruction; files the same way as "file this"
    keyword: 'file the information from the attached document',
    steps: [
      {
        name: 'append_to_page',
        args: (text) => ({
          path: GUIDE_MOVED,
          text: factsIn(text).join(' ') || 'FILE-NOT-SEEN',
          summary: /Path in folder: .*\n[\s\S]*Folder outline/.test(text) ? 'Add facts from a document (location seen)' : 'Add facts from a document',
        }),
      },
    ],
    reply: 'I proposed adding what the document says to [[docs/basics]].',
  },
  {
    // applies a changed document: replaces what it no longer says with what it now says
    keyword: 'apply the update',
    steps: [
      {
        name: 'replace_in_page',
        args: (text) => ({
          path: GUIDE_MOVED,
          old_text: text.match(/No longer says:\n\s+FACT: ([^\n]+)/)?.[1] ?? 'CHANGE-NOT-SEEN',
          new_text: text.match(/Now says:\n\s+FACT: ([^\n]+)/)?.[1] ?? 'CHANGE-NOT-SEEN',
          summary: 'Update from the new version of the sample document',
        }),
      },
    ],
    reply: 'I proposed updating the page for the new version of the sample document.',
  },
  {
    keyword: 'add a style section',
    steps: [{ name: 'append_to_page', args: { path: GUIDE_MOVED, text: '## Style\n\nTitles are short and lowercase.', summary: 'Add the style rules' } }],
    reply: 'I proposed a style section on [[docs/basics]].',
  },
  {
    // moves a pending addition from this chat to a new page
    keyword: 'move the style section',
    steps: [
      { name: 'read_page', args: { path: GUIDE_MOVED } },
      { name: 'replace_in_page', args: { path: GUIDE_MOVED, old_text: '## Style\n\nTitles are short and lowercase.', new_text: '', summary: 'Move the style rules' } },
      { name: 'create_page', args: { path: 'guide/style', content: '# Style\n\nTitles are short and lowercase.', summary: 'Move the style rules' } },
    ],
    reply: 'I moved the style section to its own page, [[guide/style]].',
  },
  {
    keyword: 'suggest a photos page',
    steps: [{ name: 'create_page', args: { path: 'gallery/photos', content: '# Photos\n\nThe gallery files pictures by month.', summary: 'New photos page' } }],
    reply: 'I proposed a photos page.',
  },
  {
    keyword: 'move the photos page',
    steps: [{ name: 'move_page', args: { path: 'gallery/photos', new_path: 'archive/photos', summary: 'Pictures belong in the archive' } }],
    reply: 'I moved the suggested photos page under archive.',
  },
  {
    keyword: 'relocate the archive photos page',
    steps: [{ name: 'move_page', args: { path: 'archive/photos', new_path: 'misc/photos', summary: 'Somewhere else' } }],
    reply: 'Done.',
  },
  {
    // answers from an original document that the wiki does not cover
    keyword: 'does the notes file say',
    steps: [
      { name: 'search_documents', args: { query: 'export tool' } },
      { name: 'read_document', args: (_text, tools) => ({ document: tools.match(/document (\d+)/)?.[1] ?? 'none', part: 1 }) },
    ],
    reply: (tools) => (tools.includes('one file per page') ? 'DOC-SEEN: one file per page, from the notes file (not in the wiki yet)' : 'DOC-NOT-SEEN'),
  },
  {
    keyword: 'add the export note',
    steps: [
      { name: 'search_documents', args: { query: 'export tool' } },
      { name: 'read_document', args: (_text, tools) => ({ document: tools.match(/document (\d+)/)?.[1] ?? 'none' }) },
      { name: 'append_to_page', args: { path: GUIDE_MOVED, text: 'The export tool writes one file per page.', summary: 'Add the export note' } },
    ],
    reply: 'I proposed adding the export note to [[docs/basics]].',
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
      { name: 'append_to_page', args: { path: GUIDE_MOVED, text: 'The PINEAPPLE code is in my planner.', summary: 'Add the note from my planner' } },
    ],
    reply: 'Done.',
  },
  {
    keyword: 'naming policy',
    steps: [
      { name: 'search_pages', args: { query: 'naming' } },
      {
        name: 'create_page',
        args: {
          path: 'guide/naming-policy',
          content: '# Naming policy\n\nPage paths are short, lowercase and describe one topic.\n\nA rename uses the move action, so links follow the page.',
          summary: 'New page: naming policy',
        },
      },
    ],
    reply: 'There was no naming policy page, so I proposed a new one at [[guide/naming-policy]].',
  },
];

// Requests the Anthropic route received, for the e2e script to inspect
export const anthropicRequests = [];

// Shown for anything outside the scenarios, so nobody mistakes the mock for a real model
const NOT_A_MODEL =
  'This is the scripted test model, not a real AI, so it can only run its demo scenarios ' +
  '(try mentioning simple markdown, where facts come from, the review list, the house style, a style section, the related pages rule or a naming policy). Connect a real model on the Settings page.';

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
  if (page) return `FACT: Scanned page ${page[1]} says the checklist was updated monthly.`;
  return 'A photo of a whiteboard. FACT: The whiteboard label reads BOARD-7.';
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
        // a plan request (the Anthropic system string says so) takes a moment too, so stopping a
        // plan is testable on this provider as well
        const isPlan =
          (typeof body.system === 'string' && body.system.includes('You plan how')) ||
          (Array.isArray(body.system) && body.system.some((b) => typeof b?.text === 'string' && b.text.includes('You plan how')));
        setTimeout(() => {
          try {
            const out = respondAnthropic(body);
            anthropicRequests.push({ beta: req.headers['anthropic-beta'], body, status: out.status });
            send(out.status, out.body);
          } catch {
            send(500, { error: 'mock failure' });
          }
        }, isPlan ? 4000 : 0);
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
      // "slowly" in the opening message makes the first model call take a moment, to see progress in the UI
      const body = JSON.parse(raw || '{}');
      const slow =
        (body.messages ?? []).some((m) => m.role === 'user' && typeof m.content === 'string' && /slowly/i.test(m.content)) &&
        !(body.messages ?? []).some((m) => m.role === 'assistant');
      setTimeout(() => send(200, respond(body)), slow ? 4000 : 0);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] || 4555);
  await startMock(port);
  console.log(`Mock model listening on http://127.0.0.1:${port}/v1`);
}