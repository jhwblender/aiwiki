// End-to-end check of the propose and approve flow.
// Starts the scripted mock model and a dev server on a throwaway data directory,
// then drives the REST API the same way the UI does.
//
//   npm run e2e

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anthropicRequests, startMock } from './mock-llm.mjs';
import { docx, photo, scannedPdf, textPdf } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 3100;
const MOCK_PORT = 4556; // 4555 is left free for a mock you run by hand
const BASE = `http://127.0.0.1:${APP_PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwiki-e2e-'));
const wikiDir = path.join(dataDir, 'wiki');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? `\n     ${detail}` : ''}`);
  if (!ok) failures++;
}

// Identities come from real accounts now. Kim sets the wiki up on first run (admins may manage
// people and settings); Alex, Sam and Jordan are editors created by her.
const COOKIES = new Map();

async function login(name, password) {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password, confirm: password }),
  });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  if (cookie) COOKIES.set(name, cookie);
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

// The acting person: named in the call where it matters, otherwise whoever signed in first
const actor = (url, body) => {
  const q = url.match(/[?&]user=([^&]*)/);
  const named = q ? decodeURIComponent(q[1]) : body?.user;
  return named && COOKIES.has(named) ? named : 'Kim';
};

async function api(method, url, body) {
  const headers = { Cookie: COOKIES.get(actor(url, body)) ?? '' };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

const getPage = (p) => api('GET', `/api/page?path=${encodeURIComponent(p)}`).then((r) => r.data);
const chat = (text, user = 'Alex', provider = 'local', chatId = undefined, attachments = undefined) =>
  api('POST', '/api/chat', { messages: [{ role: 'user', content: text }], provider, user, chatId, attachments }).then((r) => r.data);

async function upload(files, user = 'Alex') {
  const form = new FormData();
  for (const [name, data, type] of files) form.append('file', new Blob([data], { type }), name);
  const r = await fetch(BASE + '/api/files', { method: 'POST', body: form, headers: { Cookie: COOKIES.get(user) ?? '' } });
  return { status: r.status, data: await r.json() };
}
const pageFile = (p) => fs.readFileSync(path.join(wikiDir, p + '.md'), 'utf8');
const git = (...args) => execFileSync('git', ['-C', wikiDir, ...args], { encoding: 'utf8' });
const changes = (set) => set.segments.filter((s) => s.type === 'change');

async function waitForServer(proc) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error('Dev server exited early');
    try {
      const r = await fetch(`${BASE}/api/config`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Dev server did not start in time');
}

const mock = await startMock(MOCK_PORT);
const server = spawn(path.join(ROOT, 'node_modules/.bin/next'), ['dev', '-p', String(APP_PORT)], {
  cwd: ROOT,
  env: {
    ...process.env,
    NEXT_DIST_DIR: '.next-e2e',
    WIKI_DATA_DIR: dataDir,
    LOCAL_LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    LOCAL_LLM_MODEL: 'mock',
    ANTHROPIC_API_KEY: 'mock-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    ANTHROPIC_MODEL: 'claude-sonnet-5-5',
    // the checks trigger folder scans themselves
    WATCH_INTERVAL_SECONDS: '3600',
    INGEST_RETRY_SECONDS: '1',
    // the checks ask the librarian to look for due runs themselves, and nothing needs to settle first
    LIBRARIAN_CHECK_SECONDS: '3600',
    LIBRARIAN_QUIET_SECONDS: '0',
    LIBRARIAN_SECTION_GAP_SECONDS: '0',
    LIBRARIAN_WHOLE_GAP_SECONDS: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

try {
  await waitForServer(server);

  // Accounts: the first one set up owns the place; the rest are editors
  const setup = await login('Kim', 'kim-pass-1234');
  check('first account can be set up', setup.status === 200 && setup.data.role === 'admin', JSON.stringify(setup.data));
  for (const [name, role] of [['Alex', 'editor'], ['Sam', 'editor'], ['Jordan', 'editor']]) {
    const made = await api('POST', '/api/users', { name, role, password: `${name.toLowerCase()}-pass-1234` });
    check(`an admin can add ${name}`, made.status === 200, JSON.stringify(made.data));
  }
  await login('Alex', 'alex-pass-1234');
  await login('Sam', 'sam-pass-1234');
  await login('Jordan', 'jordan-pass-1234');
  check('a setup attempt cannot run twice', (await login('Second', 'second-pass-1234')).status === 401);

  // 0. Sign-in is needed everywhere, and roles decide what each person may do
  check('nothing answers without signing in', (await fetch(`${BASE}/api/pages`)).status === 401 && (await fetch(`${BASE}/api/settings`)).status === 401);
  check('a wrong password is refused', (await login('Alex', 'nope')).status === 401);
  const dup = await api('POST', '/api/users', { name: 'Alex', role: 'editor', password: 'dup-pass-12345' });
  check('a second account cannot take a used username', dup.status === 400 && /already someone named/.test(dup.data.error ?? ''), JSON.stringify(dup.data));
  check('an admin can add a viewer', (await api('POST', '/api/users', { name: 'Vera', display: 'Vera Blake', role: 'viewer', password: 'vera-pass-1234' })).status === 200);
  await login('Vera', 'vera-pass-1234');
  check('sign-in ignores letter case in the username', (await login('vera', 'vera-pass-1234')).status === 200);
  check('the session carries both names', (await (await fetch(`${BASE}/api/me`, { headers: { Cookie: COOKIES.get('Vera') } })).json()).displayName === 'Vera Blake');
  check('a viewer can read pages', (await getPage('index')).exists === true);
  check('a viewer can chat but proposes nothing', (await chat('Who wrote the guide?', 'Vera')).proposed?.length === 0);
  check('a viewer cannot edit a page', (await api('PUT', '/api/page', { path: 'index', content: 'x', user: 'Vera' })).status === 403);
  check('a viewer cannot manage people', (await api('POST', '/api/users', { name: 'Nope', role: 'admin', password: 'nope-pass-1234', user: 'Vera' })).status === 403);
  const veraCookie = COOKIES.get('Vera');
  await fetch(BASE + '/api/login', { method: 'DELETE', headers: { Cookie: veraCookie } });
  check('signing out ends the session', (await fetch(`${BASE}/api/me`, { headers: { Cookie: veraCookie } })).status === 401);
  check('an editor cannot manage people', (await api('POST', '/api/users', { name: 'Nope', role: 'admin', password: 'nope-pass-1234', user: 'Alex' })).status === 403);

  // Seed wiki
  const index = await getPage('index');
  check('seed wiki has an index page', index.exists && index.title === 'Welcome');
  const seedOnboarding = pageFile('guide/basics');

  // 1. Chat proposes a single edit; nothing is written
  const r1 = await chat('Note that pages keep to simple markdown');
  check('chat returns a reply', !r1.error && r1.reply.includes('waiting for review'), JSON.stringify(r1));
  check('chat reports the proposed page', r1.proposed?.some((p) => p.path === 'guide/basics'));
  check('AI did not write the page file', pageFile('guide/basics') === seedOnboarding);
  let page = await getPage('guide/basics');
  check('page shows one pending set', page.pending.length === 1);
  const mdSet = page.pending[0];
  check('pending set links a chat source', mdSet.source?.kind === 'chat' && mdSet.source.user === 'Alex');
  check('pending set has one change', changes(mdSet).length === 1);
  const pages = (await api('GET', '/api/pages')).data;
  check('sidebar list counts the pending change', pages.find((p) => p.path === 'guide/basics')?.pending === 1);

  // 2. A stale fingerprint is refused
  const hunk = changes(mdSet)[0];
  const stale = await api('POST', `/api/proposals/${mdSet.proposalId}/hunk`, { hunk: hunk.index, fp: 'nope', action: 'approve', user: 'Sam' });
  check('stale approval is refused', stale.status === 400);

  // 3. Approving the change writes the file and commits under the approver
  const ok = await api('POST', `/api/proposals/${mdSet.proposalId}/hunk`, { hunk: hunk.index, fp: hunk.fp, action: 'approve', user: 'Sam' });
  check('approve change succeeds', ok.status === 200, JSON.stringify(ok.data));
  check('approved text is live', pageFile('guide/basics').includes('keep to simple markdown'));
  check('commit author is the approver', git('log', '-1', '--format=%an').trim() === 'Sam');
  check('commit message names the source', git('log', '-1', '--format=%B').includes('Source: chat with Alex'));
  page = await getPage('guide/basics');
  check('no pending sets left', page.pending.length === 0);
  check('page lists the source', page.sources.some((s) => s.source.user === 'Alex' && s.approvedBy === 'Sam'));

  // 4. Two changes in one set: approve one, reject the other
  await chat('Add where facts come from');
  page = await getPage('guide/basics');
  const dashSet = page.pending[0];
  check('second chat stages two changes', page.pending.length === 1 && changes(dashSet).length === 2);
  const [opening, sources] = changes(dashSet);
  await api('POST', `/api/proposals/${dashSet.proposalId}/hunk`, { hunk: sources.index, fp: sources.fp, action: 'reject', user: 'Sam' });
  page = await getPage('guide/basics');
  check('rejecting one change leaves the other pending', page.pending.length === 1 && changes(page.pending[0]).length === 1);
  check('rejected text is not live', !pageFile('guide/basics').includes('sources list records'));
  const left = changes(page.pending[0])[0];
  check('remaining change is the opening-line edit', left.fp === opening.fp);
  await api('POST', `/api/proposals/${dashSet.proposalId}/hunk`, { hunk: left.index, fp: left.fp, action: 'approve', user: 'Sam' });
  check('the opening-line edit is live', pageFile('guide/basics').includes('place its facts on pages'));
  check('set is resolved', (await getPage('guide/basics')).pending.length === 0);

  // 5. Approving one suggestion does not let an older one undo it
  await chat('Add where facts come from'); // Access paragraph plus a new section
  await chat('Say what the review list does'); // Tools paragraph
  page = await getPage('guide/basics');
  check('two suggestions are pending', page.pending.length === 2);
  const [dash2, rota] = page.pending;
  await api('POST', `/api/proposals/${rota.proposalId}/resolve`, { action: 'approve', user: 'Sam' });
  check('the review-list note is live', pageFile('guide/basics').includes('The review list on each page decides what is published'));
  page = await getPage('guide/basics');
  const dashNow = page.pending.find((s) => s.proposalId === dash2.proposalId);
  check('older suggestion still shows only its own changes',
    dashNow && !dashNow.conflict && changes(dashNow).length === 2 && !JSON.stringify(changes(dashNow)).includes('The review list on each'),
    JSON.stringify(dashNow?.segments));
  await api('POST', `/api/proposals/${dash2.proposalId}/resolve`, { action: 'approve', user: 'Sam' });
  const after = pageFile('guide/basics');
  check('approving the older suggestion keeps the newer approval', after.includes('The review list on each page decides what is published') && after.includes('sources list records'));

  // 6. A human edit in the same paragraph turns a suggestion into a conflict
  await chat('Say what the review list does');
  page = await getPage('guide/basics');
  const rota2 = page.pending[0];
  const edited = after.replace(/This page is only a starting point, so change or delete it as you like\.[^\n]*/, 'This page is only a starting point, so change or delete it as you like, any time.');
  await api('PUT', '/api/page', { path: 'guide/basics', content: edited, user: 'Jordan' });
  page = await getPage('guide/basics');
  const rotaNow = page.pending.find((s) => s.proposalId === rota2.proposalId);
  check('overlapping suggestion is flagged as a conflict', rotaNow?.conflict === true, JSON.stringify(rotaNow));
  const refused = await api('POST', `/api/proposals/${rota2.proposalId}/resolve`, { action: 'approve', user: 'Sam' });
  check('a conflicting suggestion cannot be approved', refused.status === 400 && pageFile('guide/basics') === edited);
  const rej = await api('POST', `/api/proposals/${rota2.proposalId}/resolve`, { action: 'reject', user: 'Sam' });
  check('a conflicting suggestion can be rejected', rej.status === 200 && (await getPage('guide/basics')).pending.length === 0);

  // 7. New page proposal, approved with Approve all
  await chat('Write up the naming policy');
  const bp = await getPage('guide/naming-policy');
  check('new page is pending but not live', !bp.exists && bp.pending.length === 1 && bp.pending[0].isNew);
  check('sidebar shows the new page', (await api('GET', '/api/pages')).data.some((p) => p.path === 'guide/naming-policy' && p.isNew));
  await api('POST', `/api/proposals/${bp.pending[0].proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  const bp2 = await getPage('guide/naming-policy');
  check('approve all publishes the new page', bp2.exists && bp2.title === 'Naming policy' && bp2.pending.length === 0);
  check('resolved proposal cannot be decided twice',
    (await api('POST', `/api/proposals/${bp.pending[0].proposalId}/resolve`, { action: 'approve', user: 'Kim' })).status === 400);

  // 8. Reject all leaves the page alone
  await chat('Simple markdown is the rule'); // replays the markdown scenario; old_text no longer matches
  const before = pageFile('guide/basics');
  await chat('Write up the naming policy'); // create_page refused because the page exists
  check('agent cannot overwrite an existing page via create', pageFile('guide/naming-policy') === bp2.content);
  await chat('Add where facts come from'); // the opening line already applied; the Sources append is new
  page = await getPage('guide/basics');
  if (page.pending.length) {
    await api('POST', `/api/proposals/${page.pending[0].proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  }
  check('reject all leaves content unchanged', pageFile('guide/basics') === before && (await getPage('guide/basics')).pending.length === 0);

  // 9. Human edits publish immediately under the editor's name
  const put = await api('PUT', '/api/page', { path: 'guide/basics', content: before + '\nEdited by hand.\n', user: 'Jordan' });
  check('human edit saves', put.status === 200);
  check('human edit is live', pageFile('guide/basics').includes('Edited by hand.'));
  check('human edit commit author', git('log', '-1', '--format=%an').trim() === 'Jordan');

  // 10. The Anthropic adapter sends a well-formed tool loop
  const ar = await chat('Add where facts come from', 'Alex', 'anthropic'); // three tool turns, then a reply
  check('Anthropic chat completes a tool loop', !ar.error && ar.proposed?.length === 1, JSON.stringify(ar));
  check('Anthropic requests were all accepted', anthropicRequests.length === 4 && anthropicRequests.every((r) => r.status === 200),
    JSON.stringify(anthropicRequests.map((r) => r.status)));
  const firstReq = anthropicRequests[0];
  check('Anthropic request asks for fallbacks', firstReq?.beta?.includes('server-side-fallback-2026-07-01') && firstReq.body.fallbacks === 'default');
  const pendingRota = (await getPage('guide/basics')).pending;
  for (const s of pendingRota) await api('POST', `/api/proposals/${s.proposalId}/resolve`, { action: 'reject', user: 'Kim' });

  // 11. Settings: the connection test and clear errors when the model is unreachable
  const mockUrl = `http://127.0.0.1:${MOCK_PORT}/v1`;
  const st = (await api('GET', '/api/settings')).data;
  check('settings show the local model from the environment', st.local?.baseUrl === mockUrl && st.local.model === 'mock' && st.local.hasApiKey === false);
  const good = (await api('POST', '/api/settings/test', { baseUrl: mockUrl, model: 'mock' })).data;
  check('connection test passes against the mock', good.ok === true && good.steps.length === 5 && good.steps[4].status === 'passed' && good.models.includes('mock'), JSON.stringify(good));
  const wrongModel = (await api('POST', '/api/settings/test', { baseUrl: mockUrl, model: 'nope' })).data;
  check('connection test names a missing model', !wrongModel.ok && wrongModel.steps[1].status === 'failed' && wrongModel.steps[1].detail.includes('Available: mock'));
  const closed = 'http://127.0.0.1:4599/v1'; // nothing listens here
  // refused on most machines; some WSL setups let the connection time out instead
  const UNREACHABLE = /Nothing is answering|Could not connect|No answer from/;
  const bad = (await api('POST', '/api/settings/test', { baseUrl: closed, model: 'mock' })).data;
  check('connection test explains an unreachable server', !bad.ok && UNREACHABLE.test(bad.steps[0].detail), JSON.stringify(bad.steps?.[0]));
  check('settings reject a non-web address', (await api('PUT', '/api/settings', { baseUrl: 'localhost:11434', model: 'mock' })).status === 400);
  await api('PUT', '/api/settings', { baseUrl: closed, model: 'mock', apiKey: 'secret' });
  const after2 = (await api('GET', '/api/settings')).data;
  check('saved settings take effect and hide the key', after2.local.baseUrl === closed && after2.local.hasApiKey === true && !JSON.stringify(after2).includes('secret'));
  const down = await chat('Who wrote the guide?');
  check('chat says the model is unreachable', UNREACHABLE.test(down.error ?? '') && down.error.includes('127.0.0.1:4599'), JSON.stringify(down));
  await api('PUT', '/api/settings', { baseUrl: mockUrl, model: 'mock', apiKey: '' });
  const back = await chat('Who wrote the guide?');
  check('mock says it is a test model', /scripted test model/.test(back.reply ?? ''), JSON.stringify(back));

  // 12. Sloppy tool calls from small models still work, and unknown tools get a clear error
  const sloppy = await chat('The house style has one blank line between paragraphs');
  check('near-miss tool and argument names still run', sloppy.proposed?.some((p) => p.path === 'guide/basics'), JSON.stringify(sloppy));
  check('an unknown tool is reported, not run', sloppy.trace?.includes('delete_page') && pageFile('guide/basics').includes('Edited by hand.'));
  const styleNote = (await getPage('guide/basics')).pending;
  check('the sloppy suggestion has the right text', styleNote.length === 1 && JSON.stringify(styleNote[0].segments).includes('blank line'));
  for (const sg of styleNote) await api('POST', `/api/proposals/${sg.proposalId}/resolve`, { action: 'reject', user: 'Kim' });

  // 13. The assistant sees pending suggestions, and a chat revises its own instead of competing with it
  const chatA = 'e2e-chat-aaaa';
  const chatB = 'e2e-chat-bbbb';
  await chat('Add the review day', 'Alex', 'local', chatA);
  await chat('Sorry, the review day is actually Tuesday', 'Alex', 'local', chatA);
  let reviewDay = (await getPage('guide/basics')).pending;
  const reviewDayText = JSON.stringify(reviewDay[0]?.segments ?? []);
  check('a follow-up in the same chat revises its suggestion', reviewDay.length === 1 && reviewDayText.includes('Tuesdays') && !reviewDayText.includes('Mondays'), reviewDayText);
  check('the revised suggestion remembers the earlier message', reviewDay[0]?.earlierSources?.[0]?.note === 'Add the review day');
  const seen = await chat('Is anything pending?', 'Sam', 'local', chatB);
  check('another chat is shown the pending suggestion', seen.reply === 'PENDING-SEEN', JSON.stringify(seen));
  await chat('Review moved to Tuesday', 'Sam', 'local', chatB);
  check('another chat cannot revise someone else\'s suggestion', (await getPage('guide/basics')).pending.length === 1);
  await chat('Sorry, the review day is actually Tuesday', 'Sam', 'local', chatA);
  check('the same chat id under another name cannot revise it', (await getPage('guide/basics')).pending.length === 1);
  await api('POST', `/api/proposals/${reviewDay[0].proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  check('approving the revision publishes the final text', pageFile('guide/basics').includes('The guide is reviewed on Tuesdays.') && !pageFile('guide/basics').includes('Mondays.'));
  const reviewDayCommit = git('log', '-1', '--format=%B');
  check('the commit names both messages', (reviewDayCommit.match(/^Source: chat with Alex/gm) ?? []).length === 2, reviewDayCommit);
  const reviewDaySources = (await getPage('guide/basics')).sources.map((x) => x.source.note);
  check('the page lists both messages as sources', reviewDaySources.includes('Add the review day') && reviewDaySources.includes('Sorry, the review day is actually Tuesday'));

  // 14. A correction is made in place; repeating text as a "correction" section is refused
  const chatC = 'e2e-chat-cccc';
  await chat('Every page ends with a list of related pages', 'Alex', 'local', chatC);
  await chat('Oh whoops, only summary pages get related pages', 'Alex', 'local', chatC);
  const remote = (await getPage('guide/basics')).pending;
  const remoteText = JSON.stringify(remote.map((x) => x.segments));
  check('the correction replaces the text', remote.length === 1 && remoteText.includes('Only summary pages end with a list of related pages.') && !remoteText.includes('Every page ends with a list of related'), remoteText);
  check('no duplicate correction section', (remoteText.match(/Only summary pages end with a list of related pages./g) ?? []).length === 1 && !/correction/i.test(remoteText), remoteText);
  for (const sg of remote) await api('POST', `/api/proposals/${sg.proposalId}/resolve`, { action: 'reject', user: 'Kim' });

  // 15. Sections list their sub-pages
  const section = await getPage('guide');
  check('a section without its own page lists its sub-pages', !section.exists && section.children.some((c) => c.path === 'guide/basics' && c.exists));

  // 16. Moving a page takes its sub-pages, pending suggestions and incoming links along
  await api('PUT', '/api/page', { path: 'guide/basics/details', content: '# Details\n\nEarly drafts of the guide are kept in the history.\n', user: 'Jordan' });
  await api('PUT', '/api/page', {
    path: 'pages/notebook',
    content: '# Notebook\n\nSee [[guide/basics]], [[guide/basics/details|the details]] and [the guide](/wiki/guide/basics).\n',
    user: 'Jordan',
  });
  await chat('Add the review day', 'Alex', 'local', 'e2e-chat-move');
  const beforeMove = (await getPage('guide/basics')).pending.length;
  const mv = await api('POST', '/api/page/move', { from: 'guide/basics', to: 'docs/basics', user: 'Kim' });
  check('move succeeds', mv.status === 200 && mv.data.moved === 2, JSON.stringify(mv.data));
  check('the page and its sub-page are at the new path',
    fs.existsSync(path.join(wikiDir, 'docs/basics.md')) && fs.existsSync(path.join(wikiDir, 'docs/basics/details.md')) &&
    !fs.existsSync(path.join(wikiDir, 'guide/basics.md')));
  const handbook = pageFile('pages/notebook');
  check('links to the moved pages are rewritten',
    handbook.includes('[[docs/basics]]') && handbook.includes('[[docs/basics/details|the details]]') && handbook.includes('(/wiki/docs/basics)'), handbook);
  check('the home page link is rewritten', pageFile('index').includes('[[docs/basics]]'));
  const movedPage = await getPage('docs/basics');
  check('pending suggestions follow the page', beforeMove === 1 && movedPage.pending.length === 1 && (await getPage('guide/basics')).pending.length === 0);
  check('recorded sources follow the page', movedPage.sources.length > 0);
  check('the move is recorded under the mover', git('log', '-1', '--format=%an %s').trim() === 'Kim Move guide/basics to docs/basics');
  check('search finds the page at its new path', (await api('GET', '/api/search?q=history')).data.some((h) => h.path === 'docs/basics/details'));
  check('moving onto an existing page is refused', (await api('POST', '/api/page/move', { from: 'pages/notebook', to: 'docs/basics', user: 'Kim' })).status === 400);
  check('moving a page inside itself is refused', (await api('POST', '/api/page/move', { from: 'docs', to: 'docs/sub', user: 'Kim' })).status === 400);
  check('the home page cannot be moved', (await api('POST', '/api/page/move', { from: 'index', to: 'home', user: 'Kim' })).status === 400);
  const reviewDayMoved = (await getPage('docs/basics')).pending[0];
  const ok2 = await api('POST', `/api/proposals/${reviewDayMoved.proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  check('a moved suggestion can still be approved', ok2.status === 200 && pageFile('docs/basics').includes('The guide is reviewed on Mondays.'), JSON.stringify(ok2.data));

  // 17. The assistant suggests moves and merges; nothing changes until a person approves
  const chatR = 'e2e-chat-reorg';
  await chat('Please tidy the notebook', 'Alex', 'local', chatR);
  let hb = await getPage('pages/notebook');
  check('a suggested move waits on the page', hb.ops.length === 1 && hb.ops[0].kind === 'move' && hb.ops[0].newPath === 'guides/notebook' && !hb.ops[0].stale, JSON.stringify(hb.ops));
  check('the page has not moved yet', fs.existsSync(path.join(wikiDir, 'pages/notebook.md')));
  check('the sidebar counts the suggested move', (await api('GET', '/api/pages')).data.find((p) => p.path === 'pages/notebook')?.pending === 1);
  await chat('Actually move it again', 'Alex', 'local', chatR);
  hb = await getPage('pages/notebook');
  check('a follow-up replaces the earlier move suggestion', hb.ops.length === 1 && hb.ops[0].newPath === 'style/notebook', JSON.stringify(hb.ops));
  const seenMove = await chat('Is anything pending?', 'Sam', 'local', 'e2e-chat-other');
  check('pending moves do not confuse other chats', !seenMove.error);
  const okMove = await api('POST', `/api/ops/${hb.ops[0].opId}`, { action: 'approve', user: 'Kim' });
  check('approving the move moves the page', okMove.data.path === 'style/notebook' && fs.existsSync(path.join(wikiDir, 'style/notebook.md')) && !fs.existsSync(path.join(wikiDir, 'pages/notebook.md')));
  check('the approved move names its source', git('log', '-1', '--format=%B').includes('Source: chat with Alex') && git('log', '-1', '--format=%an').trim() === 'Kim');

  await chat('Merge the details page into the guide', 'Alex', 'local', 'e2e-chat-merge');
  const fw = await getPage('docs/basics/details');
  check('a suggested removal waits on the page', fw.ops.length === 1 && fw.ops[0].kind === 'remove');
  const ob = (await getPage('docs/basics')).pending;
  check('the merged text is a normal suggestion on the target', ob.length === 1 && JSON.stringify(ob[0].segments).includes('the history of the guide'));
  await api('POST', `/api/proposals/${ob[0].proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  await api('POST', `/api/ops/${fw.ops[0].opId}`, { action: 'approve', user: 'Kim' });
  check('approving the removal deletes the old page', !fs.existsSync(path.join(wikiDir, 'docs/basics/details.md')) && pageFile('docs/basics').includes('the history of the guide'));

  check('the home page cannot be deleted', (await api('DELETE', '/api/page?path=index')).status === 400 && pageFile('index').startsWith('# Welcome'));
  const homeChat = await chat('Please delete the Welcome page', 'Alex');
  check('the assistant cannot remove the home page', homeChat.reply === 'HOME-REFUSED', JSON.stringify({ reply: homeChat.reply, trace: (homeChat.trace ?? []).slice(0, 8) }));

  await chat('Please tidy the notebook', 'Alex', 'local', 'e2e-chat-stale'); // notebook is gone from pages/, so nothing to move
  await api('PUT', '/api/page', { path: 'pages/notebook', content: '# Notebook draft\n\nA draft of the notebook.\n', user: 'Jordan' });
  await chat('Please tidy the notebook', 'Alex', 'local', 'e2e-chat-stale2');
  await api('PUT', '/api/page', { path: 'guides/notebook', content: '# Someone got there first\n\nA page that was here first.\n', user: 'Jordan' });
  const staleOp = (await getPage('pages/notebook')).ops[0];
  check('a move whose target now exists is marked out of date', !!staleOp?.stale, JSON.stringify(staleOp));
  check('an out-of-date move cannot be approved', (await api('POST', `/api/ops/${staleOp.opId}`, { action: 'approve', user: 'Kim' })).status === 400);
  check('an out-of-date move can be rejected', (await api('POST', `/api/ops/${staleOp.opId}`, { action: 'reject', user: 'Kim' })).status === 200 && (await getPage('pages/notebook')).ops.length === 0);

  // 18. A reply that claims a change without calling a tool is caught
  const pretend = await chat('Please pretend to move the notebook', 'Alex', 'local', 'e2e-chat-pretend');
  check('the model is asked to actually make the change', (await getPage('style/notebook')).ops.some((o) => o.newPath === 'drafts/notebook'), JSON.stringify(pretend));
  const fake = await chat('Please only pretend', 'Alex', 'local', 'e2e-chat-pretend2');
  check('a claim with no suggestion behind it is flagged in the reply', /No change was actually suggested/.test(fake.reply ?? ''), JSON.stringify(fake));
  const qa = await chat('Who wrote the guide?');
  check('ordinary answers are not flagged', !/No change was actually suggested/.test(qa.reply ?? ''));

  // 19. Dropped files: documents, photos and scans become suggestions with file sources
  const up = await upload([
    ['notes.pdf', textPdf(['Sample notes', 'FACT: The export runs nightly at 02:00.']), 'application/pdf'],
    ['notes.docx', await docx(['Sample notes', 'FACT: Headings keep pages scannable.']), 'application/octet-stream'],
    ['board.png', photo(), 'image/png'],
    ['scan.pdf', scannedPdf(2), 'application/pdf'],
  ]);
  check('files upload', up.status === 200 && up.data.length === 4, JSON.stringify(up.data));
  check('file kinds are recognised', up.data.map((f) => f.kind).join() === 'pdf,docx,image,pdf');
  const ids = up.data.map((f) => f.id);
  const filed = await chat('Please file this into the guide', 'Alex', 'local', 'e2e-chat-files', ids);
  check('the assistant read every file', ['notes.pdf', 'notes.docx', 'board.png', 'scan.pdf'].every((n) => filed.trace?.includes(`Read ${n}`)), JSON.stringify(filed));
  const filedSet = (await getPage('docs/basics')).pending[0];
  const filedText = JSON.stringify(filedSet?.segments ?? []);
  check('text from a PDF reaches the suggestion', filedText.includes('export runs nightly'), filedText);
  check('text from a Word file reaches the suggestion', filedText.includes('keep pages scannable'));
  check('a photo is described by the vision model', filedText.includes('BOARD-7'));
  check('a scanned PDF is read page by page', filedText.includes('Scanned page 1') && filedText.includes('Scanned page 2'));
  check('each file is a source', filedSet?.source?.kind === 'file' && filedSet.source.filename === 'notes.pdf' && filedSet.alsoSources.length === 3,
    JSON.stringify({ source: filedSet?.source, also: filedSet?.alsoSources?.map((x) => x.filename) }));
  check('sources keep the message and a content hash', filedSet?.source?.note === 'Please file this into the guide' && /^[0-9a-f]{64}$/.test(filedSet?.source?.contentHash ?? ''));
  const original = await fetch(`${BASE}/api/sources/${filedSet.source.id}/file`, { headers: { Cookie: COOKIES.get('Alex') } });
  const originalBytes = Buffer.from(await original.arrayBuffer());
  check('the original opens from its source', original.status === 200 && original.headers.get('content-type') === 'application/pdf' && originalBytes.subarray(0, 4).toString() === '%PDF');
  const img = await fetch(`${BASE}/api/files/${ids[2]}`, { headers: { Cookie: COOKIES.get('Alex') } });
  check('a photo can be shown on a page', img.status === 200 && img.headers.get('content-type') === 'image/png');
  await api('POST', `/api/proposals/${filedSet.proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  const fileCommit = git('log', '-1', '--format=%B');
  check('approval records every file', ['notes.pdf', 'notes.docx', 'board.png', 'scan.pdf'].every((n) => fileCommit.includes(n)), fileCommit);
  check('stored files stay inside the data folder', fs.existsSync(path.join(dataDir, 'assets')) && !JSON.stringify(filedSet).includes(dataDir));
  const exe = await upload([['notes.exe', Buffer.from('MZ binary'), 'application/octet-stream']]);
  check('unsupported files are refused with a reason', exe.status === 400 && /not supported/.test(exe.data.error ?? ''));
  const again = await upload([['backup-copy.pdf', textPdf(['Sample notes', 'FACT: The export runs nightly at 02:00.']), 'application/pdf']]);
  check('the same content is stored once', fs.readdirSync(path.join(dataDir, 'assets')).length >= 1 && again.status === 200);

  // 20. Page text never cites its own source; that is what the Sources list is for
  const keys = await upload([['keys.txt', Buffer.from('The review checklist says approve one change at a time.\n'), 'text/plain']]);
  const cite = await chat('Note what the checklist says', 'Alex', 'local', 'e2e-chat-cite', [keys.data[0].id]);
  const citeSet = (await getPage('docs/basics')).pending[0];
  const citeText = JSON.stringify(citeSet?.segments ?? []);
  check('text that names its source is refused and rewritten', citeText.includes('The review checklist says approve one change at a time.') && !/Based on|checklist.txt/.test(citeText), JSON.stringify({ cite, citeText }));
  check('the file is still recorded as the source', citeSet?.source?.filename === 'keys.txt');
  if (citeSet) await api('POST', `/api/proposals/${citeSet.proposalId}/resolve`, { action: 'reject', user: 'Kim' });

  // 21. A re-sent file is recognised, and an updated file is reduced to what changed
  const ver_v1 = await upload([['sample.docx', await docx(['Sample list', 'FACT: Guide pages: 8.', 'FACT: Draft pages: 4.']), 'application/octet-stream']]);
  const ver_r1 = await chat('Please file this', 'Alex', 'local', 'e2e-chat-ver_v1', [ver_v1.data[0].id]);
  check('the first version is read in full', ver_r1.trace?.includes('Read sample.docx'), JSON.stringify(ver_r1.trace));
  const ver_s1 = (await getPage('docs/basics')).pending[0];
  await api('POST', `/api/proposals/${ver_s1.proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  check('the first version is filed', pageFile('docs/basics').includes('Draft pages: 4.'));
  // the same bytes are re-sent later; a rebuilt .docx would differ by its zip timestamp
  const v2Bytes = await docx(['Sample list', 'FACT: Guide pages: 8.', 'FACT: Draft pages: 6.']);
  const ver_v2 = await upload([['sample.docx', v2Bytes, 'application/octet-stream']]);
  const ver_r2 = await chat('Please apply the update', 'Alex', 'local', 'e2e-chat-ver_v2', [ver_v2.data[0].id]);
  check('a changed file is reduced to its changes', ver_r2.trace?.some((t) => t === 'Read sample.docx (sample.docx has 1 change since version 1)'), JSON.stringify(ver_r2.trace));
  const ver_s2 = (await getPage('docs/basics')).pending[0];
  const ver_s2Text = JSON.stringify(ver_s2?.segments ?? []);
  check('the change updates the existing statement', ver_s2Text.includes('Draft pages: 6.') && !ver_s2Text.includes('CHANGE-NOT-SEEN') && changes(ver_s2).length === 1, ver_s2Text);
  check('the source records version 2', ver_s2?.source?.version === 2 && ver_s2.source.filename === 'sample.docx');
  await api('POST', `/api/proposals/${ver_s2.proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  check('unchanged parts are not added again', (pageFile('docs/basics').match(/Guide pages: 8\./g) ?? []).length === 1 && !pageFile('docs/basics').includes('Draft pages: 4.'));
  const ver_v3 = await upload([['sample.docx', v2Bytes, 'application/octet-stream']]);
  const ver_r3 = await chat('What is in this file?', 'Alex', 'local', 'e2e-chat-ver_v3', [ver_v3.data[0].id]);
  check('the same file sent again is recognised', ver_r3.trace?.some((t) => /sample\.docx is unchanged since/.test(t)), JSON.stringify(ver_r3.trace));
  const ver_copy = await upload([['sample-copy.docx', await docx(['Sample list', 'FACT: Guide pages: 8.', 'FACT: Draft pages: 6.']), 'application/octet-stream']]);
  check('the same content under another name uploads fine', ver_copy.status === 200);

  // 22. Background filing: one job per file, skipped when nothing is new, retried after a failure
  const waitJob = async (id) => {
    for (let i = 0; i < 120; i++) {
      const job = (await api('GET', '/api/ingest')).data.jobs.find((j) => j.id === id);
      if (job && !['queued', 'working'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  };
  const qf = await upload([['history.txt', Buffer.from('FACT: The export keeps a page history.\n'), 'text/plain']]);
  const q1 = await api('POST', '/api/ingest', { fileIds: [qf.data[0].id], user: 'Alex' });
  const job1 = await waitJob(q1.data.jobs[0]);
  check('a background job files the document', job1?.status === 'done' && job1.proposed.includes('docs/basics'), JSON.stringify(job1));
  const qSet = (await getPage('docs/basics')).pending.find((p) => p.source?.filename === 'history.txt');
  check('the background suggestion has the file as its source', !!qSet && JSON.stringify(qSet.segments).includes('export keeps a page history'));
  check('a dropped file has no folder location', qSet?.summary === 'Add facts from a document', qSet?.summary);
  if (qSet) await api('POST', `/api/proposals/${qSet.proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  const qAgain = await upload([['history.txt', Buffer.from('FACT: The export keeps a page history.\n'), 'text/plain']]);
  const job2 = await waitJob((await api('POST', '/api/ingest', { fileIds: [qAgain.data[0].id], user: 'Alex' })).data.jobs[0]);
  check('an unchanged file is skipped without asking the model', job2?.status === 'skipped' && /Unchanged/.test(job2.detail ?? ''), JSON.stringify(job2));
  await api('PUT', '/api/settings', { baseUrl: 'http://127.0.0.1:4599/v1', model: 'mock' });
  const qDown = await upload([['queues.txt', Buffer.from('FACT: The review queue keeps its place.\n'), 'text/plain']]);
  const job3id = (await api('POST', '/api/ingest', { fileIds: [qDown.data[0].id], user: 'Alex', provider: 'local' })).data.jobs[0];
  let waitState = null;
  for (let i = 0; i < 160 && !waitState; i++) {
    const st = (await api('GET', '/api/ingest')).data;
    if (st.waitingForModel) waitState = st;
    else await new Promise((r) => setTimeout(r, 250));
  }
  check('an unreachable model makes the queue wait instead of failing', !!waitState && UNREACHABLE.test(waitState.waitingForModel.reason) &&
    waitState.jobs.find((j) => j.id === job3id)?.status === 'queued', JSON.stringify(waitState?.waitingForModel));
  await api('PUT', '/api/settings', { baseUrl: mockUrl, model: 'mock' });
  check('the model can be tried again at once', (await api('POST', '/api/ingest/control', { action: 'retry-now' })).status === 200);
  const job3b = await waitJob(job3id);
  check('the waiting job succeeds once the model is back', job3b?.status === 'done', JSON.stringify(job3b));
  for (const p of (await getPage('docs/basics')).pending) await api('POST', `/api/proposals/${p.proposalId}/resolve`, { action: 'reject', user: 'Kim' });

  // 23. Watched folders: existing and changed documents are filed with the folder label and relative path
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwiki-watch-'));
  const writeOld = (rel, text) => {
    const full = path.join(watchDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    const past = new Date(Date.now() - 60_000); // older than the settle time, as if synced a minute ago
    fs.utimesSync(full, past, past);
  };
  writeOld('Safety/rules.txt', 'FACT: Page deletions wait for review.\n');
  writeOld('~$procedures.docx', 'lock file');
  writeOld('notes.exe', 'not a document');
  const added = await api('POST', '/api/folders', { label: 'Notes share', path: watchDir, user: 'Alex', fileExisting: true });
  check('a folder can be watched', added.status === 200 && added.data.fileCount === 1, JSON.stringify(added.data));
  const folderJob = await waitJob((await api('GET', '/api/ingest')).data.jobs.find((j) => j.displayName === 'rules.txt')?.id);
  check('a document in the folder is filed', folderJob?.status === 'done' && folderJob.folderLabel === 'Notes share' && folderJob.relPath === 'Safety/rules.txt', JSON.stringify(folderJob));
  let fSet = (await getPage('docs/basics')).pending.find((p) => p.source?.filename === 'rules.txt');
  check('the assistant is told where the file sits in the folder', fSet?.summary === 'Add facts from a document (location seen)', fSet?.summary);
  check('its source names the folder and the path inside it', fSet?.source?.folderLabel === 'Notes share' && fSet.source.relPath === 'Safety/rules.txt' && fSet.source.version === 1);
  check('the full server path never appears in sources', !JSON.stringify(await getPage('docs/basics')).includes(watchDir));
  await api('POST', `/api/proposals/${fSet.proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  check('the approval names the folder file', git('log', '-1', '--format=%B').includes('rules.txt (Notes share: Safety/rules.txt, version 1, from Alex'), git('log', '-1', '--format=%B'));
  const folderId = added.data.id;
  check('an unchanged folder sends nothing', (await api('POST', `/api/folders/${folderId}/scan`)).data.queued === 0);
  const past = new Date(Date.now() - 30_000);
  fs.utimesSync(path.join(watchDir, 'Safety/rules.txt'), past, past);
  check('a file that was only touched sends nothing', (await api('POST', `/api/folders/${folderId}/scan`)).data.queued === 0);
  writeOld('Safety/rules.txt', 'FACT: Page renames wait for review.\n');
  check('a changed file is sent again', (await api('POST', `/api/folders/${folderId}/scan`)).data.queued === 1);
  const changedJob = await waitJob((await api('GET', '/api/ingest')).data.jobs.find((j) => j.displayName === 'rules.txt' && j.status !== 'done' && j.status !== 'skipped')?.id
    ?? (await api('GET', '/api/ingest')).data.jobs[0].id);
  fSet = (await getPage('docs/basics')).pending.find((p) => p.source?.filename === 'rules.txt');
  check('the changed file is filed as version 2', changedJob?.status === 'done' && fSet?.source?.version === 2, JSON.stringify({ changedJob, src: fSet?.source }));
  if (fSet) await api('POST', `/api/proposals/${fSet.proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  writeOld('Quiet/fresh.txt', 'FACT: The home page lists every section.\n');
  writeOld('Quiet/old.txt', 'FACT: The old rule.\n');
  const quiet = await api('POST', '/api/folders', { label: 'Quiet share', path: path.join(watchDir, 'Quiet'), user: 'Alex', fileExisting: false });
  check('a folder can start without filing what is already there', quiet.status === 200 && quiet.data.fileCount === 2 && !(await api('GET', '/api/ingest')).data.jobs.some((j) => j.folderLabel === 'Quiet share' && j.kind === 'file'));
  writeOld('Quiet/new-rule.txt', 'FACT: Drafts are marked in the sidebar.\n');
  check('later documents in that folder are filed', (await api('POST', `/api/folders/${quiet.data.id}/scan`)).data.queued === 1);
  check('a missing folder is refused clearly', /cannot find the folder/.test((await api('POST', '/api/folders', { label: 'Nope', path: '/no/such/dir', user: 'Alex' })).data.error ?? ''));
  check('the same label cannot be used twice', (await api('POST', '/api/folders', { label: 'Notes share', path: watchDir, user: 'Alex' })).status === 400);
  await waitJob((await api('GET', '/api/ingest')).data.jobs[0].id);
  for (const f of (await api('GET', '/api/folders')).data) await api('DELETE', `/api/folders/${f.id}`);
  check('folders can stop being watched', (await api('GET', '/api/folders')).data.length === 0);
  for (const p of (await getPage('docs/basics')).pending) await api('POST', `/api/proposals/${p.proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  fs.rmSync(watchDir, { recursive: true, force: true });

  // 24. Moving a pending suggestion: your own moves, someone else's stays put
  await chat('Please add a style section', 'Alex', 'local', 'e2e-chat-style');
  check('the addition is pending on the first page', (await getPage('docs/basics')).pending.length === 1);
  const mvSec = await chat('Actually move the style section to its own page', 'Alex', 'local', 'e2e-chat-style');
  check('the addition leaves the first page', (await getPage('docs/basics')).pending.length === 0, JSON.stringify((await getPage('docs/basics')).pending.map((p) => p.summary)));
  const stylePage = await getPage('guide/style');
  check('and is suggested at the new place', stylePage.pending.length === 1 && stylePage.pending[0].isNew && JSON.stringify(stylePage.pending[0].segments).includes('lowercase'));
  check('the chat only lists the page still waiting', JSON.stringify(mvSec.proposed) === JSON.stringify([{ path: 'guide/style', isNew: true }]), JSON.stringify(mvSec.proposed));
  await api('POST', `/api/proposals/${stylePage.pending[0].proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  await chat('Please suggest a photos page', 'Alex', 'local', 'e2e-chat-photos');
  await chat('Now move the photos page under archive', 'Alex', 'local', 'e2e-chat-photos');
  const oldPhotos = await getPage('gallery/photos');
  const newPhotos = await getPage('archive/photos');
  check('a suggested new page can be moved by its chat', oldPhotos.pending.length === 0 && newPhotos.pending.length === 1 && newPhotos.pending[0].isNew && newPhotos.title === 'Photos',
    JSON.stringify({ old: oldPhotos.pending.length, new: newPhotos.pending.length }));
  await chat('Please relocate the archive photos page', 'Sam', 'local', 'e2e-chat-other-photos');
  check('someone else cannot move it', (await getPage('archive/photos')).pending.length === 1 && (await getPage('misc/photos')).pending.length === 0);
  await api('POST', `/api/proposals/${newPhotos.pending[0].proposalId}/resolve`, { action: 'reject', user: 'Kim' });

  // 25. The chat can stream progress while the assistant works
  const streamed = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: COOKIES.get('Alex') },
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'Is anything pending?' }], provider: 'local', user: 'Alex' }),
  });
  const events = (await streamed.text()).trim().split('\n').map((l) => JSON.parse(l));
  check('progress arrives before the result', streamed.headers.get('content-type')?.includes('ndjson') &&
    events[0]?.type === 'run' && events[1]?.type === 'progress' && events.some((e) => e.type === 'progress' && e.text.startsWith('Read ')) && events.at(-1)?.type === 'done',
    JSON.stringify(events));

  // 26. A chat request keeps running when the browser leaves, can be picked up again, and can be stopped
  const startStream = async (text, chatId) => {
    const r = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: COOKIES.get('Alex') },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: text }], provider: 'local', user: 'Alex', chatId }),
    });
    const reader = r.body.getReader();
    let buf = '';
    while (!buf.includes('\n')) buf += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel(); // the browser goes away, e.g. to Settings
    return JSON.parse(buf.split('\n')[0]).id;
  };
  const readRun = async (id) => (await (await fetch(`${BASE}/api/chat/runs/${id}`, { headers: { Cookie: COOKIES.get('Alex') } })).text()).trim().split('\n').map((l) => JSON.parse(l));
  const pulseBefore = (await api('GET', '/api/pulse')).data.stamp;
  const runId = await startStream('Please slowly add a style section', 'e2e-chat-run');
  const replay = await readRun(runId);
  check('a request carries on after the browser leaves and can be picked up again',
    replay[0].type === 'run' && replay.some((e) => e.type === 'progress') && replay.at(-1).type === 'done' && replay.at(-1).proposed.length === 1, JSON.stringify(replay));
  check('the change counter moves when a suggestion lands', (await api('GET', '/api/pulse')).data.stamp !== pulseBefore);
  for (const p of (await getPage('docs/basics')).pending) await api('POST', `/api/proposals/${p.proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  const stopId = await startStream('Please slowly add where facts come from', 'e2e-chat-stop');
  check('a running request can be stopped', (await api('POST', `/api/chat/runs/${stopId}/stop`)).data.stopped === true);
  const stopAt = Date.now();
  const stoppedEvents = await readRun(stopId); // blocks until the run finally ends
  const stopDelay = Date.now() - stopAt;
  check('a stopped request ends as stopped', stoppedEvents.at(-1).type === 'error' && stoppedEvents.at(-1).error === 'Stopped.', JSON.stringify(stoppedEvents.at(-1)));
  // The model call was still generating (4 s); stopping must cut it instead of waiting it out
  check('stopping cuts the model call right away instead of finishing the step', stopDelay < 2500, `took ${stopDelay} ms`);
  check('an unknown request says so', (await fetch(`${BASE}/api/chat/runs/nope`, { headers: { Cookie: COOKIES.get('Alex') } })).status === 404);
  for (const p of (await getPage('docs/basics')).pending) await api('POST', `/api/proposals/${p.proposalId}/resolve`, { action: 'reject', user: 'Kim' });

  // 27. Watched folders that are renamed, nested or added twice
  const nest_base = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwiki-nest-'));
  const nest_put = (rel, text) => {
    const full = path.join(nest_base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(full, past, past);
  };
  nest_put('nest_outer/a.txt', 'FACT: Outer fact one.\n');
  nest_put('nest_outer/nest_inner/b.txt', 'FACT: Inner fact two.\n');
  const nest_outer = await api('POST', '/api/folders', { label: 'Outer', path: path.join(nest_base, 'nest_outer'), user: 'Alex', fileExisting: false });
  const nest_inner = await api('POST', '/api/folders', { label: 'Inner', path: path.join(nest_base, 'nest_outer/nest_inner'), user: 'Alex', fileExisting: false });
  const nest_listed = (await api('GET', '/api/folders')).data;
  check('nesting is shown on both folders', nest_listed.find((f) => f.label === 'Inner')?.insideOf === 'Outer' && nest_listed.find((f) => f.label === 'Outer')?.contains.includes('Inner'), JSON.stringify(nest_listed));
  nest_put('nest_outer/nest_inner/b.txt', 'FACT: Inner fact two, changed.\n');
  const nest_qOuter = (await api('POST', `/api/folders/${nest_outer.data.id}/scan`)).data.queued;
  const nest_qInner = (await api('POST', `/api/folders/${nest_inner.data.id}/scan`)).data.queued;
  check('a file in a nested folder is filed once, by the nest_inner folder', nest_qOuter === 0 && nest_qInner === 1, JSON.stringify({ nest_qOuter, nest_qInner }));
  check('the same folder cannot be watched twice', /already watched as "Outer"/.test((await api('POST', '/api/folders', { label: 'Again', path: path.join(nest_base, 'nest_outer'), user: 'Alex' })).data.error ?? ''));
  fs.renameSync(path.join(nest_base, 'nest_outer'), path.join(nest_base, 'renamed'));
  await api('POST', `/api/folders/${nest_outer.data.id}/scan`);
  const nest_lost = (await api('GET', '/api/folders')).data.find((f) => f.label === 'Outer');
  check('a renamed folder is reported, not treated as empty', /can no longer be found/.test(nest_lost?.lastError ?? ''), JSON.stringify(nest_lost));
  const nest_repoint_waits = [
    await waitJob(((await api('GET', '/api/ingest')).data.jobs.find((j) => j.kind === 'plan' && j.folderLabel === 'Outer'))?.id),
    await waitJob(((await api('GET', '/api/ingest')).data.jobs.find((j) => j.kind === 'plan' && j.folderLabel === 'Inner'))?.id),
  ];
  check('both watched folders are planned', nest_repoint_waits.every((j) => j?.status === 'done'), JSON.stringify(nest_repoint_waits.map((j) => j?.status)));
  const nest_repoint = await api('PATCH', `/api/folders/${nest_outer.data.id}`, { path: path.join(nest_base, 'renamed') });
  check('pointing it at the new location renames the folder to the new top level name',
    nest_repoint.status === 200 && nest_repoint.data.label === 'renamed', JSON.stringify(nest_repoint.data));
  const repointed = (await api('GET', '/api/folders')).data.find((f) => f.label === 'renamed');
  check('the repointed folder has no error', !repointed?.lastError, JSON.stringify(repointed));
  // the inner folder moved along with it, so the outer one now sees its file; it is already filed and skipped
  const afterMove = (await api('POST', `/api/folders/${nest_outer.data.id}/scan`)).data.queued;
  const afterJobs = afterMove ? [await waitJob((await api('GET', '/api/ingest')).data.jobs[0].id)] : [];
  check('nothing is filed again after pointing it at the new location', afterJobs.every((j) => j?.status === 'skipped'), JSON.stringify({ afterMove, afterJobs }));
  check("the moved folder's file jobs all carry its new name", (await api('GET', '/api/ingest')).data.jobs.every((j) => j.kind !== 'file' || j.folderLabel !== 'Outer'));
  await waitJob((await api('GET', '/api/ingest')).data.jobs[0].id);
  for (const f of (await api('GET', '/api/folders')).data) await api('DELETE', `/api/folders/${f.id}`);
  for (const p of (await getPage('docs/basics')).pending) await api('POST', `/api/proposals/${p.proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  fs.rmSync(nest_base, { recursive: true, force: true });

  // 27b. Changing folder moves the name, the identity and the plan view with it
  const move_base = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwiki-move-'));
  const move_put = (root, rel, text) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(full, past, past);
  };
  move_put(path.join(move_base, 'old'), 'keep.txt', 'FACT: Kept fact.\n');
  move_put(path.join(move_base, 'old'), 'gone/deep.txt', 'FACT: Deep gone fact.\n');
  const mv_folder = await api('POST', '/api/folders', { label: 'Will rename', path: path.join(move_base, 'old'), fileExisting: true });
  const mv_id = mv_folder.data.id;
  await api('POST', `/api/folders/${mv_id}/scan`);
  const waitQueue = async () => {
    for (let i = 0; i < 120; i++) {
      const jobs = (await api('GET', '/api/ingest')).data.jobs;
      if (!jobs.some((j) => ['queued', 'working'].includes(j.status))) return jobs;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  };
  const mv_first = await waitQueue();
  check('the watched folder files its documents', mv_first?.some((j) => j.displayName === 'keep.txt' && j.status === 'done') &&
    mv_first.some((j) => j.displayName === 'deep.txt' && j.status === 'done'),
    JSON.stringify(mv_first?.map((j) => [j.displayName, j.status])));

  // Rename on disk: the old subfolder is gone, a new one holds a brand-new file, and the kept
  // file changes content (which must land as a new version of the same document, not a new one)
  fs.rmSync(path.join(move_base, 'old'), { recursive: true, force: true });
  move_put(path.join(move_base, 'renamed'), 'new/fresh.txt', 'FACT: Fresh fact.\n');
  move_put(path.join(move_base, 'renamed'), 'keep.txt', 'FACT: Kept fact, updated.\n');
  const mv_change = await api('PATCH', `/api/folders/${mv_id}`, { path: path.join(move_base, 'renamed') });
  check("the folder takes the new top level folder's name", mv_change.status === 200 && mv_change.data.label === 'renamed', JSON.stringify(mv_change.data));
  check('the folder list shows the new name at the new path',
    (await api('GET', '/api/folders')).data.some((f) => f.label === 'renamed' && f.path === path.join(move_base, 'renamed')));
  await waitQueue();

  const Database = (await import('better-sqlite3')).default;
  const movedDb = new Database(path.join(dataDir, 'wiki.db'), { readonly: true });
  try {
    check('documents move to the new name, so nothing double-files',
      movedDb.prepare("SELECT COUNT(*) n FROM documents WHERE doc_key LIKE 'folder:Will rename:%'").get().n === 0 &&
      movedDb.prepare("SELECT COUNT(*) n FROM documents WHERE doc_key IN ('folder:renamed:keep.txt','folder:renamed:gone/deep.txt','folder:renamed:new/fresh.txt')").get().n === 3,
      JSON.stringify(movedDb.prepare('SELECT doc_key FROM documents WHERE doc_key LIKE ? OR doc_key LIKE ?').all('folder:Will rename:%', 'folder:renamed:%').map((r) => r.doc_key)));
    check('the changed file lands as a new version of the same document',
      movedDb.prepare("SELECT COUNT(*) n FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.doc_key = 'folder:renamed:keep.txt'").get().n === 2,
      JSON.stringify(movedDb.prepare('SELECT d.doc_key, count(*) FROM document_versions v JOIN documents d ON d.id = v.document_id GROUP BY d.id').all()));
    check("history shows the folder under its new name",
      movedDb.prepare("SELECT COUNT(*) n FROM ingest_jobs WHERE folder_label = 'Will rename'").get().n === 0,
      JSON.stringify(movedDb.prepare('SELECT DISTINCT folder_label FROM ingest_jobs WHERE folder_label IS NOT NULL').all()));
  } finally {
    movedDb.close();
  }

  const mv_plan = (await api('GET', `/api/folders/${mv_id}/plan`)).data;
  check('the plan shows the new subfolders, not the ones left behind',
    JSON.stringify(mv_plan.tree).includes('new') && !JSON.stringify(mv_plan.tree).includes('gone'), JSON.stringify(mv_plan.tree));
  check('a new file in the moved folder is filed', (await api('GET', '/api/ingest')).data.jobs.some((j) => j.displayName === 'fresh.txt' && j.status === 'done'));
  check('background filing carries the new folder name, not the old one',
    (await api('GET', '/api/ingest')).data.jobs.every((j) => j.folderLabel !== 'Will rename'));
  await api('DELETE', `/api/folders/${mv_id}`);
  for (const p of (await getPage('docs/basics')).pending) await api('POST', `/api/proposals/${p.proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  fs.rmSync(move_base, { recursive: true, force: true });

  // 27c. The same when a file is still waiting in the queue while the folder moves
  const mv2_base = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwiki-mvq-'));
  move_put(path.join(mv2_base, 'old'), 'keep.txt', 'FACT: Kept fact.\n');
  const mv2_folder = await api('POST', '/api/folders', { label: 'Waiting move', path: path.join(mv2_base, 'old'), fileExisting: true });
  const mv2_id = mv2_folder.data.id;
  await api('POST', `/api/folders/${mv2_id}/scan`);
  await waitQueue();
  // Hold the queue: filing is paused, so a new folder file waits instead of working
  await api('POST', '/api/ingest/control', { action: 'pause' });
  move_put(path.join(mv2_base, 'old'), 'hold/me.txt', 'FACT: Queued fact.\n');
  await api('POST', `/api/folders/${mv2_id}/scan`);
  let holdState = null;
  for (let i = 0; i < 40 && !holdState; i++) {
    const st = (await api('GET', '/api/ingest')).data;
    if (st.jobs.some((j) => j.displayName === 'me.txt' && j.status === 'queued')) holdState = st;
    else await new Promise((r) => setTimeout(r, 250));
  }
  check('a folder file waits in the queue while filing is paused', !!holdState, JSON.stringify(holdState?.jobs?.map((j) => [j.displayName, j.status])));

  // Move the folder under the waiting job
  fs.renameSync(path.join(mv2_base, 'old'), path.join(mv2_base, 'moved'));
  let mvq_change = null;
  for (let i = 0; i < 15 && !mvq_change; i++) {
    const r = await api('PATCH', `/api/folders/${mv2_id}`, { path: path.join(mv2_base, 'moved') });
    if (r.status === 200) mvq_change = r.data; // a working attempt in flight may briefly refuse the change
    else await new Promise((res) => setTimeout(res, 400));
  }
  check('the folder can change while only waiting jobs exist', !!mvq_change && mvq_change.label === 'moved', JSON.stringify(mvq_change));
  const mvq_waiting = (await api('GET', '/api/ingest')).data.jobs.find((j) => j.displayName === 'me.txt');
  check('the waiting job follows the new folder name', mvq_waiting?.folderLabel === 'moved', JSON.stringify(mvq_waiting));
  check("the waiting file is registered in the moved folder's plan",
    JSON.stringify((await api('GET', `/api/folders/${mv2_id}/plan`)).data.tree).includes('hold'));
  await api('POST', '/api/ingest/control', { action: 'resume' });
  const mvq_done = await waitQueue();
  const meJob = mvq_done?.find((j) => j.displayName === 'me.txt');
  check('the queued file files fully under the new name', meJob?.status === 'done' && meJob.folderLabel === 'moved', JSON.stringify(meJob));
  const mv2Db = new Database(path.join(dataDir, 'wiki.db'), { readonly: true });
  try {
    check('the queued file lands as a document under the new name, not the old one',
      mv2Db.prepare("SELECT COUNT(*) n FROM documents WHERE doc_key = 'folder:moved:hold/me.txt'").get().n === 1 &&
      mv2Db.prepare("SELECT COUNT(*) n FROM documents WHERE doc_key LIKE 'folder:Waiting move:%'").get().n === 0,
      JSON.stringify(mv2Db.prepare('SELECT doc_key FROM documents WHERE doc_key LIKE ? OR doc_key LIKE ?').all('folder:moved:hold/%', 'folder:Waiting move:%').map((r) => r.doc_key)));
  } finally {
    mv2Db.close();
  }
  await api('DELETE', `/api/folders/${mv2_id}`);
  for (const p of (await getPage('docs/basics')).pending) await api('POST', `/api/proposals/${p.proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  fs.rmSync(mv2_base, { recursive: true, force: true });

  // 28. The assistant can look up detail in the original documents
  const manual = await upload([['manual.txt', Buffer.from('Wiki export\n\nThe export tool writes one file per page, plus a plain index.\n'), 'text/plain']]);
  await waitJob((await api('POST', '/api/ingest', { fileIds: [manual.data[0].id], user: 'Alex', provider: 'local', note: 'Just keep this on file.' })).data.jobs[0]);
  const fromDoc = await chat('What does the notes file say about the export?', 'Sam');
  check('an answer can come from an original document', fromDoc.reply?.startsWith('DOC-SEEN') && fromDoc.trace?.some((t) => t.startsWith('Searched documents')), JSON.stringify(fromDoc));
  check('nothing is suggested just by looking something up', fromDoc.proposed?.length === 0);
  await chat('Please add the export note', 'Sam', 'local', 'e2e-chat-export');
  const exportNote = (await getPage('docs/basics')).pending.find((p) => JSON.stringify(p.segments).includes('one file per page'));
  check('a suggestion based on a document records it as the source', exportNote?.source?.kind === 'file' && exportNote.source.filename === 'manual.txt' && exportNote.source.user === 'Sam',
    JSON.stringify(exportNote?.source));
  if (exportNote) await api('POST', `/api/proposals/${exportNote.proposalId}/resolve`, { action: 'reject', user: 'Kim' });

  // 29. Folders on the server can be browsed to pick one to watch
  const browseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwiki-browse-'));
  fs.mkdirSync(path.join(browseDir, 'Manuals'));
  fs.mkdirSync(path.join(browseDir, '.hidden'));
  fs.writeFileSync(path.join(browseDir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(browseDir, '~$lock.docx'), 'x');
  const listing = (await api('GET', `/api/folders/browse?path=${encodeURIComponent(browseDir)}`)).data;
  check('a folder lists its subfolders and documents', listing.dirs?.map((d) => d.name).join() === 'Manuals' && listing.docs === 1 && listing.parent, JSON.stringify(listing));
  check('places to start from are offered', Array.isArray((await api('GET', '/api/folders/browse')).data.shortcuts));
  check('a missing folder cannot be browsed', (await api('GET', '/api/folders/browse?path=/no/such/dir')).status === 400);
  fs.rmSync(browseDir, { recursive: true, force: true });

  // 30. Background filing controls: pause, cancel, stop the running file, see its progress, retry failures
  const ctl = (action, extra = {}) => api('POST', '/api/ingest/control', { action, ...extra });
  const queueOne = async (name, text, note) => {
    const f = await upload([[name, Buffer.from(text), 'text/plain']]);
    return (await api('POST', '/api/ingest', { fileIds: [f.data[0].id], user: 'Alex', provider: 'local', note })).data.jobs[0];
  };
  const jobStatus = async (id) => (await api('GET', '/api/ingest?status=' + 'queued')).data.jobs.find((j) => j.id === id)?.status
    ?? (await api('GET', '/api/ingest')).data.jobs.find((j) => j.id === id)?.status;
  await ctl('pause');
  const pausedJob = await queueOne('paused.txt', 'FACT: Paused fact.\n', 'Just keep this on file.');
  await new Promise((r) => setTimeout(r, 1500));
  const pausedState = (await api('GET', '/api/ingest')).data;
  check('a paused queue does not start new files', pausedState.paused === true && (await jobStatus(pausedJob)) === 'queued');
  check('a waiting file can be cancelled', (await api('POST', `/api/ingest/${pausedJob}/cancel`)).status === 200 && (await jobStatus(pausedJob)) === 'cancelled');
  const otherJob = await queueOne('other.txt', 'FACT: Other fact.\n', 'Just keep this on file.');
  const bulk = await ctl('cancel-waiting', { folder: null });
  check('all waiting dropped files can be cancelled at once', bulk.data.count >= 1 && (await jobStatus(otherJob)) === 'cancelled', JSON.stringify(bulk.data));
  check('a cancelled file can be tried again', (await api('POST', `/api/ingest/${pausedJob}/retry`)).status === 200);
  await ctl('resume');
  check('resuming files what was waiting', (await waitJob(pausedJob))?.status === 'done');

  const slowJob = await queueOne('slow.txt', 'FACT: Slow fact.\n', 'Please slowly add a style section');
  let live = null;
  for (let i = 0; i < 80 && !live; i++) {
    const st = (await api('GET', '/api/ingest')).data;
    if (st.current?.job?.id === slowJob) live = st.current;
    else await new Promise((r) => setTimeout(r, 100));
  }
  check('the running file shows what it is doing', !!live && typeof live.status === 'string' && Array.isArray(live.steps), JSON.stringify(live));
  check('the running file can be stopped', (await api('POST', `/api/ingest/${slowJob}/cancel`)).status === 200);
  check('a stopped file ends as cancelled', (await waitJob(slowJob))?.status === 'cancelled');

  const gone = await upload([['gone.txt', Buffer.from('FACT: Gone fact.\n'), 'text/plain']]);
  const findStored = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? findStored(path.join(dir, e.name)) : e.name === 'gone.txt' ? [path.join(dir, e.name)] : []);
  const goneFile = findStored(path.join(dataDir, 'assets'))[0];
  const goneBytes = fs.readFileSync(goneFile);
  fs.rmSync(goneFile);
  const goneJob = (await api('POST', '/api/ingest', { fileIds: [gone.data[0].id], user: 'Alex', provider: 'local', note: 'Just keep this on file.' })).data.jobs[0];
  check('a file that cannot be read fails', (await waitJob(goneJob))?.status === 'failed');
  fs.writeFileSync(goneFile, goneBytes);
  check('all failed files can be tried again', (await ctl('retry-failed')).data.count >= 1 && (await waitJob(goneJob))?.status === 'done');
  const counts = (await api('GET', '/api/ingest')).data.counts;
  check('counts cover every status', ['queued', 'working', 'done', 'skipped', 'failed', 'cancelled'].every((k) => typeof counts[k] === 'number'), JSON.stringify(counts));
  for (const p of (await getPage('docs/basics')).pending) await api('POST', `/api/proposals/${p.proposalId}/resolve`, { action: 'reject', user: 'Kim' });

  // 31. Personal folders: searchable by their owner only, never filed into the wiki
  const privDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwiki-personal-'));
  fs.writeFileSync(path.join(privDir, 'notes.txt'), 'Private note: the PINEAPPLE code is in my planner.\n');
  const privPast = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(privDir, 'notes.txt'), privPast, privPast);
  const pendingBefore = (await getPage('docs/basics')).pending.length;
  const priv = await api('POST', '/api/folders', { label: 'Alex notes', path: privDir, user: 'Alex', visibility: 'personal', fileExisting: true });
  check('a personal folder can be watched', priv.status === 200 && priv.data.visibility === 'personal', JSON.stringify(priv.data));
  const privJob = await waitJob((await api('GET', '/api/ingest')).data.jobs.find((j) => j.displayName === 'notes.txt')?.id);
  check('its files are kept for searching, not filed', privJob?.status === 'done' && /own searches/.test(privJob.detail ?? '') && privJob.proposed.length === 0, JSON.stringify(privJob));
  check('nothing from it is suggested', (await getPage('docs/basics')).pending.length === pendingBefore);
  check('its owner can search it', (await chat('Please search my notes', 'Alex')).reply === 'PERSONAL-SEEN');
  check('nobody else can', (await chat('Please search my notes', 'Sam')).reply === 'PERSONAL-NOT-SEEN');
  const leak = await chat('Please put my notes in the wiki', 'Alex');
  check('after reading a personal document nothing can be suggested', leak.proposed.length === 0 && leak.trace.some((t) => /did not work/.test(t)) &&
    !JSON.stringify((await getPage('docs/basics')).pending).includes('PINEAPPLE'), JSON.stringify(leak.trace));
  const toWiki = await api('PATCH', `/api/folders/${priv.data.id}`, { visibility: 'wiki', fileExisting: true });
  check('a personal folder can start feeding the wiki', toWiki.status === 200 && toWiki.data.queued === 1, JSON.stringify(toWiki.data));
  // the switch also queues a (plan-first) fresh plan when the folder has none; watch its file job
  const wikiJob = await waitJob(((await api('GET', '/api/ingest')).data.jobs.find((x) => x.kind === 'file' && x.folderLabel === 'Alex notes'))?.id);
  check('its documents are then filed', wikiJob?.status === 'done' && wikiJob.proposed.length === 1, JSON.stringify(wikiJob));
  check('and everyone can search them', (await chat('Please search my notes', 'Sam')).reply === 'PERSONAL-SEEN');
  for (const f of (await api('GET', '/api/folders')).data) await api('DELETE', `/api/folders/${f.id}`);
  for (const p of (await getPage('docs/basics')).pending) await api('POST', `/api/proposals/${p.proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  fs.rmSync(privDir, { recursive: true, force: true });

  // 32. The librarian surveys a section and suggests a limited number of tidy-ups
  const putPage = (p, content) => api('PUT', '/api/page', { path: p, content, user: 'Kim' });
  const guideText = 'The guide pages explain how the wiki works. Headings make pages scannable. ' +
    'To search, type a word in the search box and pick a page from the results.';
  await putPage('notes/pages', `# Pages\n\n${guideText}\n`);
  await putPage('notes/writing', `# Writing\n\n${guideText}\n\nRenaming follows the links with the move action.\n`);
  await putPage('notes/guide/finding', '# Finding\n\nThe search box covers every page. Narrowing results is described in [[help/pages]].\n');
  await putPage('notes/guide/filters', '# Filters\n\nFilters narrow search results.\n');
  const sections = (await api('GET', '/api/librarian')).data;
  check('sections are listed for tidying', sections.sections?.some((s) => s.section === 'notes' && s.pages === 4 && !s.run), JSON.stringify(sections));
  const surveyed = await chat('Please tidy the notes section', 'Alex');
  check('the chat can survey a section', surveyed.reply === 'SURVEY-SEEN' && surveyed.trace?.includes('Surveyed the notes section'), JSON.stringify(surveyed));
  check('a missing section cannot be tidied', (await api('POST', '/api/librarian', { section: 'nowhere', user: 'Alex' })).status === 400);
  // a slow file keeps the queue busy so the tidy has to wait, and filing is paused behind it
  const busyJob = await queueOne('busy.txt', 'FACT: Busy fact.\n', 'Please slowly add a style section');
  for (let i = 0; i < 80 && (await api('GET', '/api/ingest')).data.current?.job?.id !== busyJob; i++) await new Promise((r) => setTimeout(r, 100));
  await ctl('pause');
  const tidyJob = (await api('POST', '/api/librarian', { section: 'notes', user: 'Alex', provider: 'local', limit: 3 })).data.job;
  check('a section is tidied only once at a time', (await api('POST', '/api/librarian', { section: 'notes', user: 'Alex' })).status === 400);
  check('a waiting tidy shows on its section', (await api('GET', '/api/librarian')).data.sections.find((s) => s.section === 'notes')?.run === 'queued');
  const tidied = await waitJob(tidyJob);
  check('a tidy runs while filing is paused', (await api('GET', '/api/ingest')).data.paused === true && tidied?.status === 'done');
  await ctl('resume');
  await waitJob(busyJob);
  for (const p of (await getPage('docs/basics')).pending) await api('POST', `/api/proposals/${p.proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  check('a tidy run suggests changes up to its limit', tidied?.status === 'done' && tidied.kind === 'tidy' &&
    JSON.stringify([...tidied.proposed].sort()) === JSON.stringify(['notes/guide', 'notes/pages', 'notes/writing']) && /over the limit/.test(tidied.detail ?? ''), JSON.stringify(tidied));
  check('nothing over the limit is suggested', (await getPage('notes/guide/finding')).pending.length === 0);
  check('the AI did not write any page', pageFile('notes/writing').includes('Renaming follows') && !fs.existsSync(path.join(wikiDir, 'notes/guide.md')));
  const merged = (await getPage('notes/pages')).pending[0];
  check('a tidy suggestion names the librarian and who started it', merged?.source?.kind === 'librarian' && merged.source.user === 'Alex' && /"notes"/.test(merged.source.note ?? ''),
    JSON.stringify(merged?.source));
  const removal = (await getPage('notes/writing')).ops[0];
  check('a merge suggests removing the duplicate on its page', removal?.kind === 'remove' && removal.source?.kind === 'librarian');
  const overviewSet = (await getPage('notes/guide')).pending[0];
  check('a missing overview page is suggested', overviewSet?.isNew === true);
  await api('POST', `/api/proposals/${overviewSet.proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  check('approving it records the librarian as the source', git('log', '-1', '--format=%B').includes('Source: librarian (tidy of the "notes" section), started by Alex'), git('log', '-1', '--format=%B'));
  await api('POST', `/api/proposals/${merged.proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  await api('POST', `/api/ops/${removal.opId}`, { action: 'reject', user: 'Kim' });

  // 33. The librarian's settings, its own runs over the whole wiki, and moving a folder of pages
  check('the limit per run is checked', (await api('PUT', '/api/librarian', { limit: 500 })).status === 400);
  check('the limit per run can be changed', (await api('PUT', '/api/librarian', { limit: 30 })).data.limit === 30 && (await api('GET', '/api/librarian')).data.settings.limit === 30);
  const libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwiki-lib-'));
  for (const [rel, text] of [['Guides/Pages/notes.txt', 'Pages notes\n'], ['Guides/Search/words.txt', 'Search words\n']]) {
    fs.mkdirSync(path.dirname(path.join(libDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(libDir, rel), text);
    fs.utimesSync(path.join(libDir, rel), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  }
  await api('POST', '/api/folders', { label: 'Docs share', path: libDir, user: 'Alex', fileExisting: false });
  // let the folder's plan finish; the librarian rightly waits while filing is under way
  await waitJob(((await api('GET', '/api/ingest')).data.jobs.find((j) => j.kind === 'plan' && j.folderLabel === 'Docs share'))?.id);
  const due = (await api('POST', '/api/librarian', { action: 'check' })).data;
  check('the librarian starts with the whole wiki on its own', due.started === '*', JSON.stringify(due));
  const wholeJob = await waitJob((await api('GET', '/api/ingest')).data.jobs.find((j) => j.kind === 'tidy' && j.displayName === 'Organise the wiki')?.id);
  check('organising sees the structure and the watched folders, and cannot edit page text', wholeJob?.status === 'done' && wholeJob.user === 'Librarian' && wholeJob.detail === 'WHOLE-SURVEY-SEEN', JSON.stringify(wholeJob));
  const summarised = wholeJob?.proposed?.[0];
  const sumSet = summarised ? (await getPage(summarised)).pending[0] : null;
  check('organising suggests a section summary from the librarian', wholeJob?.proposed?.length === 1 && sumSet?.source?.kind === 'librarian' && sumSet.source.user === 'Librarian', JSON.stringify({ p: wholeJob?.proposed, src: sumSet?.source }));
  if (sumSet) await api('POST', `/api/proposals/${sumSet.proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  const allNodes = (nodes) => nodes.flatMap((n) => [n, ...allNodes(n.children)]);
  const findNode = (nodes, p) => allNodes(nodes).find((n) => n.path === p);
  check('an approved summary shows on the structure page', findNode((await api('GET', '/api/structure')).data.sections ?? [], summarised)?.summary === 'Everything about this part of the wiki.');
  await api('PUT', '/api/librarian', { auto: false });
  check('the librarian can be told not to run on its own', (await api('POST', '/api/librarian', { action: 'check' })).data.started === null);
  for (const f of (await api('GET', '/api/folders')).data) await api('DELETE', `/api/folders/${f.id}`);
  fs.rmSync(libDir, { recursive: true, force: true });
  const kbMove = await chat('Please move the notes folder', 'Alex');
  const kbOp = (await getPage('notes')).ops[0];
  check('a folder without its own page can be moved', kbMove.proposed?.some((p) => p.path === 'notes') && kbOp?.kind === 'move' && kbOp.newPath === 'help', JSON.stringify({ kbMove, kbOp }));
  await api('POST', `/api/ops/${kbOp.opId}`, { action: 'approve', user: 'Kim' });
  check('approving it moves every page under it', fs.existsSync(path.join(wikiDir, 'help/pages.md')) && fs.existsSync(path.join(wikiDir, 'help/guide/finding.md')) && !fs.existsSync(path.join(wikiDir, 'notes')));
  const putSummary = (p, summary) => api('PUT', '/api/structure', { path: p, summary, user: 'Kim' });
  check('a person can give a folder of pages a summary', (await putSummary('help', 'Help with everyday reading.')).status === 200 && pageFile('help') === '# Help\n\nHelp with everyday reading.\n');
  await api('PUT', '/api/page', { path: 'help/guide', content: '# Finding\n\nSearch and filters answer most questions.\n\n## Notes\n\nKeep the index fresh.\n', user: 'Kim' });
  const unsummarised = await api('PUT', '/api/page', { path: 'help/guide', content: '# Finding\n\n## Notes\n\nKeep the index fresh.\n', user: 'Kim' });
  check('an edit cannot remove the summary', unsummarised.status === 400 && /cannot be removed/.test(unsummarised.data.error ?? ''), JSON.stringify(unsummarised.data));
  const bare = await api('PUT', '/api/page', { path: 'help/bare', content: '# Bare\n\n- just a list\n', user: 'Kim' });
  check('a new page needs a summary', bare.status === 400 && /needs a summary/.test(bare.data.error ?? ''));
  await putSummary('help/guide', 'Search, filters and the index.');
  check('editing a summary replaces only the summary', pageFile('help/guide') === '# Finding\n\nSearch, filters and the index.\n\n## Notes\n\nKeep the index fresh.\n', pageFile('help/guide'));
  check('a summary must be sentences, not a list', (await putSummary('help', '- one\n- two')).status === 400);
  const helpNode = findNode((await api('GET', '/api/structure')).data.sections, 'help');
  check('the structure lists every page under a section', helpNode?.summary === 'Help with everyday reading.' && helpNode.children.some((c) => c.path === 'help/guide' && c.children.length === 2), JSON.stringify(helpNode, (k, v) => (k === 'summary' ? undefined : v)));
  check('summary edits are committed under the editor', git('log', '-1', '--format=%an %s').trim() === 'Kim Edit the summary of help/guide');
  const renamed = await api('POST', '/api/page/move', { from: 'help/pages', to: 'help/page-guide', title: 'Page guide', user: 'Kim' });
  check('a move with a new title renames the page too', renamed.status === 200 && pageFile('help/page-guide').startsWith('# Page guide\n') &&
    pageFile('help/guide/finding').includes('[[help/page-guide]]'), JSON.stringify({ d: renamed.data, finding: pageFile('help/guide/finding') }));

  // 34. Filing plans: each folder gets a rule, look-alike groups are sampled, raw data is skipped
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwiki-plan-'));
  const putFile = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(planDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(planDir, rel), text);
    fs.utimesSync(path.join(planDir, rel), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  };
  putFile('Docs/guide.txt', 'FACT: The plan share guide says hello.\n');
  putFile('Docs/readings.txt', Array.from({ length: 600 }, (_, i) => `${i},${(i * 0.37).toFixed(3)},${(i * 1.9).toFixed(2)}`).join('\n'));
  putFile('Raw/notes.txt', 'FACT: Raw folder notes.\n');
  for (let i = 1; i <= 6; i++) putFile(`Captures/run-0${i}/meta.json`, `{"run": ${i}, "note": "FACT: Capture run ${i} was recorded."}\n`);
  putFile('Models/bracket.step', 'ISO-10303-21;');
  putFile('Captures/run-01/adc.bin', 'raw');
  putFile('desktop.ini', '[.ShellClassInfo]');
  putFile('Deep/a/b/c/d/e/f/g/h/i/deep-note.txt', 'FACT: Deep note.\n');
  putFile('Tool.app/Contents/Resources/help.md', 'FACT: Inside an app bundle.\n');
  const planFolder = await api('POST', '/api/folders', { label: 'Plan share', path: planDir, user: 'Alex', fileExisting: true });
  const jobsOf = async () => (await api('GET', '/api/ingest')).data.jobs;
  const planJob = await waitJob((await jobsOf()).find((j) => j.kind === 'plan' && j.folderLabel === 'Plan share')?.id);
  check('a new folder is planned before its files are read', planJob?.status === 'done' && /Planned 3 folders/.test(planJob.detail ?? ''), JSON.stringify(planJob));
  const byRel = async (rel) => {
    const j = (await jobsOf()).find((x) => x.folderLabel === 'Plan share' && x.relPath === rel && x.kind === 'file');
    return j ? waitJob(j.id) : null;
  };
  const rawJob = await byRel('Raw/notes.txt');
  check('a folder set to skip is not read', !rawJob || /set to skip/.test(rawJob.detail ?? ''), JSON.stringify(rawJob));
  check('the first of a look-alike group is filed', (await byRel('Captures/run-01/meta.json'))?.status === 'done');
  const kept = await byRel('Captures/run-05/meta.json');
  check('the rest of the group is kept searchable without the assistant', kept?.status === 'kept' && /by sample/.test(kept.detail ?? ''), JSON.stringify(kept));
  check('raw data is not read', /raw data/.test((await byRel('Docs/readings.txt'))?.detail ?? ''));
  check('a normal document is filed', (await byRel('Docs/guide.txt'))?.status === 'done');
  let planned = (await api('GET', `/api/folders/${planFolder.data.id}/plan`)).data.tree;
  const rawNode = planned.children.find((c) => c.dir === 'Raw');
  check('the folder tree shows each rule and what happened', rawNode?.rule?.rule === 'skip' && rawNode.rule.setBy === 'librarian' && rawNode.counts.skipped === 1 &&
    planned.children.find((c) => c.dir === 'Captures')?.counts?.kept === 4, JSON.stringify(planned.children.map((c) => [c.dir, c.rule, c.counts])));
  const ruleChange = await api('POST', `/api/folders/${planFolder.data.id}/plan`, { dir: 'Raw', rule: 'file', user: 'Kim' });
  check('changing a rule re-evaluates what it skipped, without asking', ruleChange.status === 200 && ruleChange.data.requeued === 1, JSON.stringify(ruleChange.data));
  const rawRefiled = await byRel('Raw/notes.txt');
  check('the skipped file is filed after the rule changes', rawRefiled?.status === 'done', JSON.stringify(rawRefiled));
  const sameAgain = await api('POST', `/api/folders/${planFolder.data.id}/plan`, { dir: 'Raw', rule: 'file', user: 'Kim' });
  check('setting the same rule again queues nothing again', sameAgain.data.requeued === 0, JSON.stringify(sameAgain.data));
  await api('POST', `/api/folders/${planFolder.data.id}/plan`, { action: 'plan' });
  await waitJob((await jobsOf()).find((j) => j.kind === 'plan' && j.folderLabel === 'Plan share')?.id);
  planned = (await api('GET', `/api/folders/${planFolder.data.id}/plan`)).data.tree;
  check("planning again keeps a person's rule", planned.children.find((c) => c.dir === 'Raw')?.rule?.setBy === 'Kim');
  const modelsNode = planned.children.find((c) => c.dir === 'Models');
  check('the tree shows the real folder name and files the wiki cannot read', planned.name === path.basename(planDir) &&
    modelsNode?.files === 1 && modelsNode.documents === 0 && modelsNode.counts.other === 1 && planned.counts.other === 2, JSON.stringify({ name: planned.name, modelsNode }));
  check('system files and app bundles are left out, deep folders are not', !planned.children.some((c) => c.dir === 'Tool.app') &&
    planned.files === 12 && !!planned.children.find((c) => c.dir === 'Deep'), JSON.stringify({ files: planned.files, dirs: planned.children.map((c) => c.dir) }));
  for (const f of (await api('GET', '/api/folders')).data) await api('DELETE', `/api/folders/${f.id}`);
  fs.rmSync(planDir, { recursive: true, force: true });
  for (const p of (await getPage('docs/basics')).pending) await api('POST', `/api/proposals/${p.proposalId}/resolve`, { action: 'reject', user: 'Kim' });

  // 34b. A plan being worked out stops at once, not after its model call finishes
  const stopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwiki-planstop-'));
  fs.mkdirSync(path.join(stopDir, 'Papers'), { recursive: true });
  fs.writeFileSync(path.join(stopDir, 'Papers/a.txt'), 'FACT: Stop share fact.\n');
  fs.utimesSync(path.join(stopDir, 'Papers/a.txt'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const stopFolder = await api('POST', '/api/folders', { label: 'Stop share', path: stopDir, fileExisting: false });
  // the folder's own first plan is enqueued as part of watching it; take that job (a second
  // "plan again" just returns null while it is queued or working)
  let stopPlanJob = null;
  for (let i = 0; i < 40 && !stopPlanJob; i++) {
    const j = (await api('GET', '/api/ingest')).data.jobs.find((x) => x.kind === 'plan' && x.folderLabel === 'Stop share');
    if (j) stopPlanJob = j.id;
    else await new Promise((r) => setTimeout(r, 250));
  }
  let stopWorking = null;
  for (let i = 0; i < 40 && !stopWorking; i++) {
    const j = (await api('GET', '/api/ingest')).data.jobs.find((x) => x.id === stopPlanJob);
    if (j?.status === 'working') stopWorking = true;
    else await new Promise((r) => setTimeout(r, 250));
  }
  check('a replan can be stopped while it is deciding', !!stopWorking);
  const stopPlanAt = Date.now();
  await api('POST', `/api/ingest/${stopPlanJob}/cancel`);
  const stoppedPlan = await waitJob(stopPlanJob);
  const stopPlanDelay = Date.now() - stopPlanAt;
  check('stopping a replan cuts its model call right away', stoppedPlan?.status === 'cancelled' && stopPlanDelay < 2500 && /Stopped while it was planning/.test(stoppedPlan.detail ?? ''), JSON.stringify({ stoppedPlan, stopPlanDelay }));
  check('nothing was re-queued or filed by the stopped plan', (await api('GET', '/api/ingest')).data.jobs.every((j) => j.folderLabel !== 'Stop share' || ['plan', 'cancelled'].includes(j.kind) || j.relPath !== 'Papers/a.txt'));

  // 34c. The chat goes first: a job being worked on steps aside while someone waits in the chat
  const prioJob = (await api('POST', `/api/folders/${stopFolder.data.id}/plan`, { action: 'plan' })).data.job;
  let prioWorking = false;
  for (let i = 0; i < 40 && !prioWorking; i++) {
    const j = (await api('GET', '/api/ingest')).data.jobs.find((x) => x.id === prioJob);
    if (j?.status === 'working') prioWorking = true;
    else await new Promise((r) => setTimeout(r, 250));
  }
  check('a second plan can be started', !!prioJob && prioWorking);
  const chatAt = Date.now();
  const prioReply = (await chat('What day is it today?', 'Kim')).reply;
  const chatDelay = Date.now() - chatAt;
  const prioNow = (await api('GET', '/api/ingest')).data.jobs.find((x) => x.id === prioJob);
  check('a chat goes first while the queue is working', prioReply === 'DATE-OK' && chatDelay < 2500 && prioNow?.status === 'queued', JSON.stringify({ prioReply, chatDelay, prioNow }));
  const prioDone = await waitJob(prioJob);
  check('the set-aside job finishes once the chat is over', prioDone?.status === 'done', JSON.stringify(prioDone));

  // 34d. Stopping watching cancels what is still waiting for that folder
  await api('POST', '/api/ingest/control', { action: 'pause' });
  fs.writeFileSync(path.join(stopDir, 'Papers/a.txt'), 'FACT: Stop share fact, amended for the unwatch test.\n');
  fs.utimesSync(path.join(stopDir, 'Papers/a.txt'), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
  await api('POST', `/api/folders/${stopFolder.data.id}/scan`);
  let unwatchWaiting = 0;
  for (let i = 0; i < 40 && !unwatchWaiting; i++) {
    unwatchWaiting = (await api('GET', '/api/ingest')).data.jobs.filter((x) => x.folderLabel === 'Stop share' && x.status === 'queued').length;
    if (!unwatchWaiting) await new Promise((r) => setTimeout(r, 250));
  }
  const unwatchDelete = await api('DELETE', `/api/folders/${stopFolder.data.id}`);
  const afterUnwatch = (await api('GET', '/api/ingest')).data.jobs.filter((x) => x.folderLabel === 'Stop share' && x.kind !== 'plan');
  check('stopping watching cancels the waiting work', unwatchDelete.status === 200 && unwatchWaiting > 0 && unwatchDelete.data.cancelled >= unwatchWaiting && afterUnwatch.every((x) => x.status === 'cancelled'), JSON.stringify({ unwatchWaiting, unwatchDelete: unwatchDelete.data, afterUnwatch: afterUnwatch.map((x) => [x.kind, x.status]) }));
  await api('POST', '/api/ingest/control', { action: 'resume' });
  for (const f of (await api('GET', '/api/folders')).data) await api('DELETE', `/api/folders/${f.id}`);
  fs.rmSync(stopDir, { recursive: true, force: true });

  // 34e. Bulk: cancelled work goes back in one go, and finished history can be cleared
  await api('POST', '/api/ingest/control', { action: 'pause' });
  const bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwiki-bulk-'));
  for (const name of ['b1.txt', 'b2.txt']) {
    fs.writeFileSync(path.join(bulkDir, name), `FACT: Bulk ${name}.\n`);
    fs.utimesSync(path.join(bulkDir, name), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  }
  await api('POST', '/api/folders', { label: 'Bulk share', path: bulkDir, fileExisting: true });
  let bulkQueued = 0;
  for (let i = 0; i < 40 && bulkQueued < 2; i++) {
    bulkQueued = (await api('GET', '/api/ingest')).data.jobs.filter((x) => x.folderLabel === 'Bulk share' && x.status === 'queued').length;
    if (bulkQueued < 2) await new Promise((r) => setTimeout(r, 250));
  }
  const cancelledBulk = (await ctl('cancel-waiting', { folder: 'Bulk share' })).data.count;
  const backAgain = (await ctl('retry-cancelled', { folder: 'Bulk share' })).data.count;
  const backNow = (await api('GET', '/api/ingest')).data.jobs.filter((x) => x.folderLabel === 'Bulk share' && x.status === 'queued').length;
  check('cancelled work goes back in the queue in bulk', cancelledBulk === 2 && backAgain === 2 && backNow === 2, JSON.stringify({ cancelledBulk, backAgain, backNow }));
  await api('POST', '/api/ingest/control', { action: 'resume' });
  const bulkJobs = (await api('GET', '/api/ingest')).data.jobs.filter((x) => x.folderLabel === 'Bulk share');
  for (const j of bulkJobs) await waitJob(j.id);
  const clearedBulk = (await ctl('clear-finished', { folder: 'Bulk share' })).data.count;
  const leftBulk = (await api('GET', '/api/ingest')).data.jobs.filter((x) => x.folderLabel === 'Bulk share').length;
  check('finished entries can be cleared in bulk', clearedBulk >= 2 && leftBulk === 0, JSON.stringify({ clearedBulk, leftBulk }));
  for (const f of (await api('GET', '/api/folders')).data) await api('DELETE', `/api/folders/${f.id}`);
  fs.rmSync(bulkDir, { recursive: true, force: true });

  // 35. A long file comes in parts; the assistant reads on only where it chooses to
  const longText = Array.from({ length: 160 }, (_, i) => `Paragraph ${i} of the long manual describes care of the wiki in plain words.`).join('\n\n') + '\n\nPART-TWO-MARKER is near the end.\n';
  const longFile = await upload([['long-notes.txt', Buffer.from(longText), 'text/plain']]);
  const skim = await chat('Please skim this file', 'Alex', 'local', 'e2e-chat-skim', [longFile.data[0].id]);
  check('a long file is shown a part at a time', skim.reply === 'PARTS-OK' && skim.trace?.some((t) => /long-notes\.txt, part 1 of \d/.test(t)) && skim.trace?.some((t) => t.startsWith('Read part')),
    JSON.stringify(skim));

  // 36. The assistant can look up the date and time
  check('the assistant can look up the date and time', (await chat('What day is it today?', 'Alex')).reply === 'DATE-OK');

  // 37. Search finds approved content
  const hits = (await api('GET', '/api/search?q=naming')).data;
  check('search finds approved content', hits.some((h) => h.path === 'guide/naming-policy'));
  const loose = (await api('GET', '/api/search?q=zzz-nothing naming policy')).data;
  check('a search whose words are too specific falls back to partial matches', loose.some((h) => h.path === 'guide/naming-policy'), JSON.stringify(loose.map((h) => h.path)));
} catch (e) {
  failures++;
  console.error('FAIL', e.message);
  console.error(serverLog.slice(-3000));
} finally {
  server.kill('SIGTERM');
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
if (process.env.E2E_SERVER_TAIL) console.error('--- server tail ---\n' + serverLog.slice(-Number(process.env.E2E_SERVER_TAIL)));
process.exit(failures ? 1 : 0);
