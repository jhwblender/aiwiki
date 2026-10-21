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

async function api(method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

const getPage = (p) => api('GET', `/api/page?path=${encodeURIComponent(p)}`).then((r) => r.data);
const chat = (text, user = 'Alex', provider = 'local', chatId = undefined, attachments = undefined) =>
  api('POST', '/api/chat', { messages: [{ role: 'user', content: text }], provider, user, chatId, attachments }).then((r) => r.data);

async function upload(files, user = 'Alex') {
  const form = new FormData();
  for (const [name, data, type] of files) form.append('file', new Blob([data], { type }), name);
  form.append('user', user);
  const r = await fetch(BASE + '/api/files', { method: 'POST', body: form });
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
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

try {
  await waitForServer(server);

  // Seed wiki
  const index = await getPage('index');
  check('seed wiki has an index page', index.exists && index.title === 'Welcome');
  const seedOnboarding = pageFile('systems/onboarding');

  // 1. Chat proposes a single edit; nothing is written
  const r1 = await chat('The VPN form moved to the IT portal');
  check('chat returns a reply', !r1.error && r1.reply.includes('waiting for review'), JSON.stringify(r1));
  check('chat reports the proposed page', r1.proposed?.some((p) => p.path === 'systems/onboarding'));
  check('AI did not write the page file', pageFile('systems/onboarding') === seedOnboarding);
  let page = await getPage('systems/onboarding');
  check('page shows one pending set', page.pending.length === 1);
  const vpnSet = page.pending[0];
  check('pending set links a chat source', vpnSet.source?.kind === 'chat' && vpnSet.source.user === 'Alex');
  check('pending set has one change', changes(vpnSet).length === 1);
  const pages = (await api('GET', '/api/pages')).data;
  check('sidebar list counts the pending change', pages.find((p) => p.path === 'systems/onboarding')?.pending === 1);

  // 2. A stale fingerprint is refused
  const hunk = changes(vpnSet)[0];
  const stale = await api('POST', `/api/proposals/${vpnSet.proposalId}/hunk`, { hunk: hunk.index, fp: 'nope', action: 'approve', user: 'Sam' });
  check('stale approval is refused', stale.status === 400);

  // 3. Approving the change writes the file and commits under the approver
  const ok = await api('POST', `/api/proposals/${vpnSet.proposalId}/hunk`, { hunk: hunk.index, fp: hunk.fp, action: 'approve', user: 'Sam' });
  check('approve change succeeds', ok.status === 200, JSON.stringify(ok.data));
  check('approved text is live', pageFile('systems/onboarding').includes('through the IT portal'));
  check('commit author is the approver', git('log', '-1', '--format=%an').trim() === 'Sam');
  check('commit message names the source', git('log', '-1', '--format=%B').includes('Source: chat with Alex'));
  page = await getPage('systems/onboarding');
  check('no pending sets left', page.pending.length === 0);
  check('page lists the source', page.sources.some((s) => s.source.user === 'Alex' && s.approvedBy === 'Sam'));

  // 4. Two changes in one set: approve one, reject the other
  await chat('Add the dashboard link and badge pickup');
  page = await getPage('systems/onboarding');
  const dashSet = page.pending[0];
  check('second chat stages two changes', page.pending.length === 1 && changes(dashSet).length === 2);
  const [badge, dash] = changes(dashSet);
  await api('POST', `/api/proposals/${dashSet.proposalId}/hunk`, { hunk: dash.index, fp: dash.fp, action: 'reject', user: 'Sam' });
  page = await getPage('systems/onboarding');
  check('rejecting one change leaves the other pending', page.pending.length === 1 && changes(page.pending[0]).length === 1);
  check('rejected text is not live', !pageFile('systems/onboarding').includes('grafana'));
  const left = changes(page.pending[0])[0];
  check('remaining change is the badge edit', left.fp === badge.fp);
  await api('POST', `/api/proposals/${dashSet.proposalId}/hunk`, { hunk: left.index, fp: left.fp, action: 'approve', user: 'Sam' });
  check('badge edit is live', pageFile('systems/onboarding').includes('Collect your badge'));
  check('set is resolved', (await getPage('systems/onboarding')).pending.length === 0);

  // 5. Approving one suggestion does not let an older one undo it
  await chat('Add the dashboard link and badge pickup'); // Access paragraph plus a new section
  await chat('Mention when the rotation changes over'); // Tools paragraph
  page = await getPage('systems/onboarding');
  check('two suggestions are pending', page.pending.length === 2);
  const [dash2, rota] = page.pending;
  await api('POST', `/api/proposals/${rota.proposalId}/resolve`, { action: 'approve', user: 'Sam' });
  check('rotation note is live', pageFile('systems/onboarding').includes('changes over on Mondays'));
  page = await getPage('systems/onboarding');
  const dashNow = page.pending.find((s) => s.proposalId === dash2.proposalId);
  check('older suggestion still shows only its own changes',
    dashNow && !dashNow.conflict && changes(dashNow).length === 2 && !JSON.stringify(changes(dashNow)).includes('Mondays'),
    JSON.stringify(dashNow?.segments));
  await api('POST', `/api/proposals/${dash2.proposalId}/resolve`, { action: 'approve', user: 'Sam' });
  const after = pageFile('systems/onboarding');
  check('approving the older suggestion keeps the newer approval', after.includes('Mondays') && after.includes('grafana'));

  // 6. A human edit in the same paragraph turns a suggestion into a conflict
  await chat('Mention when the rotation changes over');
  page = await getPage('systems/onboarding');
  const rota2 = page.pending[0];
  const edited = after.replace(/Ask your manager to add you to both\.[^\n]*/, 'Ask the team lead to add you to both.');
  await api('PUT', '/api/page', { path: 'systems/onboarding', content: edited, user: 'Jordan' });
  page = await getPage('systems/onboarding');
  const rotaNow = page.pending.find((s) => s.proposalId === rota2.proposalId);
  check('overlapping suggestion is flagged as a conflict', rotaNow?.conflict === true, JSON.stringify(rotaNow));
  const refused = await api('POST', `/api/proposals/${rota2.proposalId}/resolve`, { action: 'approve', user: 'Sam' });
  check('a conflicting suggestion cannot be approved', refused.status === 400 && pageFile('systems/onboarding') === edited);
  const rej = await api('POST', `/api/proposals/${rota2.proposalId}/resolve`, { action: 'reject', user: 'Sam' });
  check('a conflicting suggestion can be rejected', rej.status === 200 && (await getPage('systems/onboarding')).pending.length === 0);

  // 7. New page proposal, approved with Approve all
  await chat('Write up our backup schedule');
  const bp = await getPage('systems/backup-policy');
  check('new page is pending but not live', !bp.exists && bp.pending.length === 1 && bp.pending[0].isNew);
  check('sidebar shows the new page', (await api('GET', '/api/pages')).data.some((p) => p.path === 'systems/backup-policy' && p.isNew));
  await api('POST', `/api/proposals/${bp.pending[0].proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  const bp2 = await getPage('systems/backup-policy');
  check('approve all publishes the new page', bp2.exists && bp2.title === 'Backup policy' && bp2.pending.length === 0);
  check('resolved proposal cannot be decided twice',
    (await api('POST', `/api/proposals/${bp.pending[0].proposalId}/resolve`, { action: 'approve', user: 'Kim' })).status === 400);

  // 8. Reject all leaves the page alone
  await chat('The VPN is now WireGuard'); // replays the VPN scenario; old_text no longer matches
  const before = pageFile('systems/onboarding');
  await chat('Write up our backup schedule'); // create_page refused because the page exists
  check('agent cannot overwrite an existing page via create', pageFile('systems/backup-policy') === bp2.content);
  await chat('Add the dashboard link and badge pickup'); // badge text already there; dashboard append is new
  page = await getPage('systems/onboarding');
  if (page.pending.length) {
    await api('POST', `/api/proposals/${page.pending[0].proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  }
  check('reject all leaves content unchanged', pageFile('systems/onboarding') === before && (await getPage('systems/onboarding')).pending.length === 0);

  // 9. Human edits publish immediately under the editor's name
  const put = await api('PUT', '/api/page', { path: 'systems/onboarding', content: before + '\nEdited by hand.\n', user: 'Jordan' });
  check('human edit saves', put.status === 200);
  check('human edit is live', pageFile('systems/onboarding').includes('Edited by hand.'));
  check('human edit commit author', git('log', '-1', '--format=%an').trim() === 'Jordan');

  // 10. The Anthropic adapter sends a well-formed tool loop
  const ar = await chat('Add the dashboard link and badge pickup', 'Alex', 'anthropic'); // three tool turns, then a reply
  check('Anthropic chat completes a tool loop', !ar.error && ar.proposed?.length === 1, JSON.stringify(ar));
  check('Anthropic requests were all accepted', anthropicRequests.length === 4 && anthropicRequests.every((r) => r.status === 200),
    JSON.stringify(anthropicRequests.map((r) => r.status)));
  const firstReq = anthropicRequests[0];
  check('Anthropic request asks for fallbacks', firstReq?.beta?.includes('server-side-fallback-2026-07-01') && firstReq.body.fallbacks === 'default');
  const pendingRota = (await getPage('systems/onboarding')).pending;
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
  const down = await chat('Who runs payroll?');
  check('chat says the model is unreachable', UNREACHABLE.test(down.error ?? '') && down.error.includes('127.0.0.1:4599'), JSON.stringify(down));
  await api('PUT', '/api/settings', { baseUrl: mockUrl, model: 'mock', apiKey: '' });
  const back = await chat('Who runs payroll?');
  check('mock says it is a test model', /scripted test model/.test(back.reply ?? ''), JSON.stringify(back));

  // 12. Sloppy tool calls from small models still work, and unknown tools get a clear error
  const sloppy = await chat('Staff parking is in lot B');
  check('near-miss tool and argument names still run', sloppy.proposed?.some((p) => p.path === 'systems/onboarding'), JSON.stringify(sloppy));
  check('an unknown tool is reported, not run', sloppy.trace?.includes('delete_page') && pageFile('systems/onboarding').includes('Edited by hand.'));
  const parking = (await getPage('systems/onboarding')).pending;
  check('the sloppy suggestion has the right text', parking.length === 1 && JSON.stringify(parking[0].segments).includes('lot B'));
  for (const sg of parking) await api('POST', `/api/proposals/${sg.proposalId}/resolve`, { action: 'reject', user: 'Kim' });

  // 13. The assistant sees pending suggestions, and a chat revises its own instead of competing with it
  const chatA = 'e2e-chat-aaaa';
  const chatB = 'e2e-chat-bbbb';
  await chat('Add the team lunch day', 'Alex', 'local', chatA);
  await chat('Sorry, lunch is actually on Tuesday', 'Alex', 'local', chatA);
  let lunch = (await getPage('systems/onboarding')).pending;
  const lunchText = JSON.stringify(lunch[0]?.segments ?? []);
  check('a follow-up in the same chat revises its suggestion', lunch.length === 1 && lunchText.includes('Tuesdays') && !lunchText.includes('Mondays'), lunchText);
  check('the revised suggestion remembers the earlier message', lunch[0]?.earlierSources?.[0]?.note === 'Add the team lunch day');
  const seen = await chat('Is anything pending on onboarding?', 'Sam', 'local', chatB);
  check('another chat is shown the pending suggestion', seen.reply === 'PENDING-SEEN', JSON.stringify(seen));
  await chat('Lunch moved to Tuesday', 'Sam', 'local', chatB);
  check('another chat cannot revise someone else\'s suggestion', (await getPage('systems/onboarding')).pending.length === 1);
  await chat('Sorry, lunch is actually on Tuesday', 'Sam', 'local', chatA);
  check('the same chat id under another name cannot revise it', (await getPage('systems/onboarding')).pending.length === 1);
  await api('POST', `/api/proposals/${lunch[0].proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  check('approving the revision publishes the final text', pageFile('systems/onboarding').includes('Team lunch is on Tuesdays.') && !pageFile('systems/onboarding').includes('Mondays.'));
  const lunchCommit = git('log', '-1', '--format=%B');
  check('the commit names both messages', (lunchCommit.match(/^Source: chat with Alex/gm) ?? []).length === 2, lunchCommit);
  const lunchSources = (await getPage('systems/onboarding')).sources.map((x) => x.source.note);
  check('the page lists both messages as sources', lunchSources.includes('Add the team lunch day') && lunchSources.includes('Sorry, lunch is actually on Tuesday'));

  // 14. A correction is made in place; repeating text as a "correction" section is refused
  const chatC = 'e2e-chat-cccc';
  await chat('Mondays and Fridays are remote work days', 'Alex', 'local', chatC);
  await chat('Oh whoops, only Mondays', 'Alex', 'local', chatC);
  const remote = (await getPage('systems/onboarding')).pending;
  const remoteText = JSON.stringify(remote.map((x) => x.segments));
  check('the correction replaces the text', remote.length === 1 && remoteText.includes('Every Monday is remote.') && !remoteText.includes('Fridays are remote'), remoteText);
  check('no duplicate correction section', (remoteText.match(/Every Monday is remote\./g) ?? []).length === 1 && !/correction/i.test(remoteText), remoteText);
  for (const sg of remote) await api('POST', `/api/proposals/${sg.proposalId}/resolve`, { action: 'reject', user: 'Kim' });

  // 15. Sections list their sub-pages
  const section = await getPage('systems');
  check('a section without its own page lists its sub-pages', !section.exists && section.children.some((c) => c.path === 'systems/onboarding' && c.exists));

  // 16. Moving a page takes its sub-pages, pending suggestions and incoming links along
  await api('PUT', '/api/page', { path: 'systems/onboarding/first-week', content: '# First week\n\nShadow the on-call engineer.\n', user: 'Jordan' });
  await api('PUT', '/api/page', {
    path: 'team/handbook',
    content: '# Handbook\n\nSee [[systems/onboarding]], [[systems/onboarding/first-week|week one]] and [the guide](/wiki/systems/onboarding).\n',
    user: 'Jordan',
  });
  await chat('Add the team lunch day', 'Alex', 'local', 'e2e-chat-move');
  const beforeMove = (await getPage('systems/onboarding')).pending.length;
  const mv = await api('POST', '/api/page/move', { from: 'systems/onboarding', to: 'team/onboarding', user: 'Kim' });
  check('move succeeds', mv.status === 200 && mv.data.moved === 2, JSON.stringify(mv.data));
  check('the page and its sub-page are at the new path',
    fs.existsSync(path.join(wikiDir, 'team/onboarding.md')) && fs.existsSync(path.join(wikiDir, 'team/onboarding/first-week.md')) &&
    !fs.existsSync(path.join(wikiDir, 'systems/onboarding.md')));
  const handbook = pageFile('team/handbook');
  check('links to the moved pages are rewritten',
    handbook.includes('[[team/onboarding]]') && handbook.includes('[[team/onboarding/first-week|week one]]') && handbook.includes('(/wiki/team/onboarding)'), handbook);
  check('the home page link is rewritten', pageFile('index').includes('[[team/onboarding]]'));
  const movedPage = await getPage('team/onboarding');
  check('pending suggestions follow the page', beforeMove === 1 && movedPage.pending.length === 1 && (await getPage('systems/onboarding')).pending.length === 0);
  check('recorded sources follow the page', movedPage.sources.length > 0);
  check('the move is recorded under the mover', git('log', '-1', '--format=%an %s').trim() === 'Kim Move systems/onboarding to team/onboarding');
  check('search finds the page at its new path', (await api('GET', '/api/search?q=shadow')).data.some((h) => h.path === 'team/onboarding/first-week'));
  check('moving onto an existing page is refused', (await api('POST', '/api/page/move', { from: 'team/handbook', to: 'team/onboarding', user: 'Kim' })).status === 400);
  check('moving a page inside itself is refused', (await api('POST', '/api/page/move', { from: 'team', to: 'team/sub', user: 'Kim' })).status === 400);
  check('the home page cannot be moved', (await api('POST', '/api/page/move', { from: 'index', to: 'home', user: 'Kim' })).status === 400);
  const lunchMoved = (await getPage('team/onboarding')).pending[0];
  const ok2 = await api('POST', `/api/proposals/${lunchMoved.proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  check('a moved suggestion can still be approved', ok2.status === 200 && pageFile('team/onboarding').includes('Team lunch is on Mondays.'), JSON.stringify(ok2.data));

  // 17. The assistant suggests moves and merges; nothing changes until a person approves
  const chatR = 'e2e-chat-reorg';
  await chat('Please tidy the handbook', 'Alex', 'local', chatR);
  let hb = await getPage('team/handbook');
  check('a suggested move waits on the page', hb.ops.length === 1 && hb.ops[0].kind === 'move' && hb.ops[0].newPath === 'guides/handbook' && !hb.ops[0].stale, JSON.stringify(hb.ops));
  check('the page has not moved yet', fs.existsSync(path.join(wikiDir, 'team/handbook.md')));
  check('the sidebar counts the suggested move', (await api('GET', '/api/pages')).data.find((p) => p.path === 'team/handbook')?.pending === 1);
  await chat('Actually move it again', 'Alex', 'local', chatR);
  hb = await getPage('team/handbook');
  check('a follow-up replaces the earlier move suggestion', hb.ops.length === 1 && hb.ops[0].newPath === 'policies/handbook', JSON.stringify(hb.ops));
  const seenMove = await chat('Is anything pending on onboarding?', 'Sam', 'local', 'e2e-chat-other');
  check('pending moves do not confuse other chats', !seenMove.error);
  const okMove = await api('POST', `/api/ops/${hb.ops[0].opId}`, { action: 'approve', user: 'Kim' });
  check('approving the move moves the page', okMove.data.path === 'policies/handbook' && fs.existsSync(path.join(wikiDir, 'policies/handbook.md')) && !fs.existsSync(path.join(wikiDir, 'team/handbook.md')));
  check('the approved move names its source', git('log', '-1', '--format=%B').includes('Source: chat with Alex') && git('log', '-1', '--format=%an').trim() === 'Kim');

  await chat('Merge first week into onboarding', 'Alex', 'local', 'e2e-chat-merge');
  const fw = await getPage('team/onboarding/first-week');
  check('a suggested removal waits on the page', fw.ops.length === 1 && fw.ops[0].kind === 'remove');
  const ob = (await getPage('team/onboarding')).pending;
  check('the merged text is a normal suggestion on the target', ob.length === 1 && JSON.stringify(ob[0].segments).includes('whole week'));
  await api('POST', `/api/proposals/${ob[0].proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  await api('POST', `/api/ops/${fw.ops[0].opId}`, { action: 'approve', user: 'Kim' });
  check('approving the removal deletes the old page', !fs.existsSync(path.join(wikiDir, 'team/onboarding/first-week.md')) && pageFile('team/onboarding').includes('whole week'));

  await chat('Please tidy the handbook', 'Alex', 'local', 'e2e-chat-stale'); // handbook is gone from team/, so nothing to move
  await api('PUT', '/api/page', { path: 'team/handbook', content: '# Handbook draft\n', user: 'Jordan' });
  await chat('Please tidy the handbook', 'Alex', 'local', 'e2e-chat-stale2');
  await api('PUT', '/api/page', { path: 'guides/handbook', content: '# Someone got there first\n', user: 'Jordan' });
  const staleOp = (await getPage('team/handbook')).ops[0];
  check('a move whose target now exists is marked out of date', !!staleOp?.stale, JSON.stringify(staleOp));
  check('an out-of-date move cannot be approved', (await api('POST', `/api/ops/${staleOp.opId}`, { action: 'approve', user: 'Kim' })).status === 400);
  check('an out-of-date move can be rejected', (await api('POST', `/api/ops/${staleOp.opId}`, { action: 'reject', user: 'Kim' })).status === 200 && (await getPage('team/handbook')).ops.length === 0);

  // 18. A reply that claims a change without calling a tool is caught
  const pretend = await chat('Please pretend to move the handbook', 'Alex', 'local', 'e2e-chat-pretend');
  check('the model is asked to actually make the change', (await getPage('policies/handbook')).ops.some((o) => o.newPath === 'manuals/handbook'), JSON.stringify(pretend));
  const fake = await chat('Please only pretend', 'Alex', 'local', 'e2e-chat-pretend2');
  check('a claim with no suggestion behind it is flagged in the reply', /No change was actually suggested/.test(fake.reply ?? ''), JSON.stringify(fake));
  const qa = await chat('Who runs payroll?');
  check('ordinary answers are not flagged', !/No change was actually suggested/.test(qa.reply ?? ''));

  // 19. Dropped files: documents, photos and scans become suggestions with file sources
  const up = await upload([
    ['backup.pdf', textPdf(['Backup notes', 'FACT: The backup NAS is in rack 7.']), 'application/pdf'],
    ['generator.docx', await docx(['Generator', 'FACT: The generator is in the basement.']), 'application/octet-stream'],
    ['rack.png', photo(), 'image/png'],
    ['scan.pdf', scannedPdf(2), 'application/pdf'],
  ]);
  check('files upload', up.status === 200 && up.data.length === 4, JSON.stringify(up.data));
  check('file kinds are recognised', up.data.map((f) => f.kind).join() === 'pdf,docx,image,pdf');
  const ids = up.data.map((f) => f.id);
  const filed = await chat('Please file this into onboarding', 'Alex', 'local', 'e2e-chat-files', ids);
  check('the assistant read every file', ['backup.pdf', 'generator.docx', 'rack.png', 'scan.pdf'].every((n) => filed.trace?.includes(`Read ${n}`)), JSON.stringify(filed));
  const filedSet = (await getPage('team/onboarding')).pending[0];
  const filedText = JSON.stringify(filedSet?.segments ?? []);
  check('text from a PDF reaches the suggestion', filedText.includes('backup NAS is in rack 7'), filedText);
  check('text from a Word file reaches the suggestion', filedText.includes('generator is in the basement'));
  check('a photo is described by the vision model', filedText.includes('RACK-7'));
  check('a scanned PDF is read page by page', filedText.includes('Scanned page 1') && filedText.includes('Scanned page 2'));
  check('each file is a source', filedSet?.source?.kind === 'file' && filedSet.source.filename === 'backup.pdf' && filedSet.alsoSources.length === 3,
    JSON.stringify({ source: filedSet?.source, also: filedSet?.alsoSources?.map((x) => x.filename) }));
  check('sources keep the message and a content hash', filedSet?.source?.note === 'Please file this into onboarding' && /^[0-9a-f]{64}$/.test(filedSet?.source?.contentHash ?? ''));
  const original = await fetch(`${BASE}/api/sources/${filedSet.source.id}/file`);
  const originalBytes = Buffer.from(await original.arrayBuffer());
  check('the original opens from its source', original.status === 200 && original.headers.get('content-type') === 'application/pdf' && originalBytes.subarray(0, 4).toString() === '%PDF');
  const img = await fetch(`${BASE}/api/files/${ids[2]}`);
  check('a photo can be shown on a page', img.status === 200 && img.headers.get('content-type') === 'image/png');
  await api('POST', `/api/proposals/${filedSet.proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  const fileCommit = git('log', '-1', '--format=%B');
  check('approval records every file', ['backup.pdf', 'generator.docx', 'rack.png', 'scan.pdf'].every((n) => fileCommit.includes(n)), fileCommit);
  check('stored files stay inside the data folder', fs.existsSync(path.join(dataDir, 'assets')) && !JSON.stringify(filedSet).includes(dataDir));
  const exe = await upload([['notes.exe', Buffer.from('MZ binary'), 'application/octet-stream']]);
  check('unsupported files are refused with a reason', exe.status === 400 && /not supported/.test(exe.data.error ?? ''));
  const again = await upload([['backup-copy.pdf', textPdf(['Backup notes', 'FACT: The backup NAS is in rack 7.']), 'application/pdf']]);
  check('the same content is stored once', fs.readdirSync(path.join(dataDir, 'assets')).length >= 1 && again.status === 200);

  // 20. Page text never cites its own source; that is what the Sources list is for
  const keys = await upload([['keys.txt', Buffer.from('The spare keys are in the blue cabinet.\n'), 'text/plain']]);
  const cite = await chat('Note where the keys are', 'Alex', 'local', 'e2e-chat-cite', [keys.data[0].id]);
  const citeSet = (await getPage('team/onboarding')).pending[0];
  const citeText = JSON.stringify(citeSet?.segments ?? []);
  check('text that names its source is refused and rewritten', citeText.includes('The spare keys are in the blue cabinet.') && !/Based on|keys\.txt/.test(citeText), JSON.stringify({ cite, citeText }));
  check('the file is still recorded as the source', citeSet?.source?.filename === 'keys.txt');
  if (citeSet) await api('POST', `/api/proposals/${citeSet.proposalId}/resolve`, { action: 'reject', user: 'Kim' });

  // 21. A re-sent file is recognised, and an updated file is reduced to what changed
  const ver_v1 = await upload([['parts.docx', await docx(['Parts list', 'FACT: Spare propellers: 8.', 'FACT: Spare batteries: 4.']), 'application/octet-stream']]);
  const ver_r1 = await chat('Please file this', 'Alex', 'local', 'e2e-chat-ver_v1', [ver_v1.data[0].id]);
  check('the first version is read in full', ver_r1.trace?.includes('Read parts.docx'), JSON.stringify(ver_r1.trace));
  const ver_s1 = (await getPage('team/onboarding')).pending[0];
  await api('POST', `/api/proposals/${ver_s1.proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  check('the first version is filed', pageFile('team/onboarding').includes('Spare batteries: 4.'));
  const ver_v2 = await upload([['parts.docx', await docx(['Parts list', 'FACT: Spare propellers: 8.', 'FACT: Spare batteries: 6.']), 'application/octet-stream']]);
  const ver_r2 = await chat('Please apply the update', 'Alex', 'local', 'e2e-chat-ver_v2', [ver_v2.data[0].id]);
  check('a changed file is reduced to its changes', ver_r2.trace?.some((t) => t === 'Read parts.docx (parts.docx has 1 change since version 1)'), JSON.stringify(ver_r2.trace));
  const ver_s2 = (await getPage('team/onboarding')).pending[0];
  const ver_s2Text = JSON.stringify(ver_s2?.segments ?? []);
  check('the change updates the existing statement', ver_s2Text.includes('Spare batteries: 6.') && !ver_s2Text.includes('CHANGE-NOT-SEEN') && changes(ver_s2).length === 1, ver_s2Text);
  check('the source records version 2', ver_s2?.source?.version === 2 && ver_s2.source.filename === 'parts.docx');
  await api('POST', `/api/proposals/${ver_s2.proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  check('unchanged parts are not added again', (pageFile('team/onboarding').match(/Spare propellers: 8\./g) ?? []).length === 1 && !pageFile('team/onboarding').includes('Spare batteries: 4.'));
  const ver_v3 = await upload([['parts.docx', await docx(['Parts list', 'FACT: Spare propellers: 8.', 'FACT: Spare batteries: 6.']), 'application/octet-stream']]);
  const ver_r3 = await chat('What is in this file?', 'Alex', 'local', 'e2e-chat-ver_v3', [ver_v3.data[0].id]);
  check('the same file sent again is recognised', ver_r3.trace?.some((t) => /parts\.docx is unchanged since/.test(t)), JSON.stringify(ver_r3.trace));
  const ver_copy = await upload([['parts-ver_copy.docx', await docx(['Parts list', 'FACT: Spare propellers: 8.', 'FACT: Spare batteries: 6.']), 'application/octet-stream']]);
  check('the same content under another name uploads fine', ver_copy.status === 200);

  // 22. Background filing: one job per file, skipped when nothing is new, retried after a failure
  const waitJob = async (id) => {
    for (let i = 0; i < 120; i++) {
      const job = (await api('GET', '/api/ingest')).data.find((j) => j.id === id);
      if (job && !['queued', 'working'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  };
  const qf = await upload([['printers.txt', Buffer.from('FACT: The printer is on floor 2.\n'), 'text/plain']]);
  const q1 = await api('POST', '/api/ingest', { fileIds: [qf.data[0].id], user: 'Alex' });
  const job1 = await waitJob(q1.data.jobs[0]);
  check('a background job files the document', job1?.status === 'done' && job1.proposed.includes('team/onboarding'), JSON.stringify(job1));
  const qSet = (await getPage('team/onboarding')).pending.find((p) => p.source?.filename === 'printers.txt');
  check('the background suggestion has the file as its source', !!qSet && JSON.stringify(qSet.segments).includes('printer is on floor 2'));
  if (qSet) await api('POST', `/api/proposals/${qSet.proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  const qAgain = await upload([['printers.txt', Buffer.from('FACT: The printer is on floor 2.\n'), 'text/plain']]);
  const job2 = await waitJob((await api('POST', '/api/ingest', { fileIds: [qAgain.data[0].id], user: 'Alex' })).data.jobs[0]);
  check('an unchanged file is skipped without asking the model', job2?.status === 'skipped' && /Unchanged/.test(job2.detail ?? ''), JSON.stringify(job2));
  await api('PUT', '/api/settings', { baseUrl: 'http://127.0.0.1:4599/v1', model: 'mock' });
  const qDown = await upload([['phones.txt', Buffer.from('FACT: The desk phone extension is 4021.\n'), 'text/plain']]);
  const job3 = await waitJob((await api('POST', '/api/ingest', { fileIds: [qDown.data[0].id], user: 'Alex', provider: 'local' })).data.jobs[0]);
  check('a job fails clearly when the model is unreachable', job3?.status === 'failed' && UNREACHABLE.test(job3.detail ?? ''), JSON.stringify(job3));
  await api('PUT', '/api/settings', { baseUrl: mockUrl, model: 'mock' });
  check('a failed job can be retried', (await api('POST', `/api/ingest/${job3.id}/retry`)).status === 200);
  const job3b = await waitJob(job3.id);
  check('the retried job succeeds', job3b?.status === 'done', JSON.stringify(job3b));
  for (const p of (await getPage('team/onboarding')).pending) await api('POST', `/api/proposals/${p.proposalId}/resolve`, { action: 'reject', user: 'Kim' });

  // 23. Watched folders: existing and changed documents are filed with the folder label and relative path
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwiki-watch-'));
  const writeOld = (rel, text) => {
    const full = path.join(watchDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    const past = new Date(Date.now() - 60_000); // older than the settle time, as if synced a minute ago
    fs.utimesSync(full, past, past);
  };
  writeOld('Safety/procedures.txt', 'FACT: The fire drill is in March.\n');
  writeOld('~$procedures.docx', 'lock file');
  writeOld('notes.exe', 'not a document');
  const added = await api('POST', '/api/folders', { label: 'Ops share', path: watchDir, user: 'Alex', fileExisting: true });
  check('a folder can be watched', added.status === 200 && added.data.fileCount === 1, JSON.stringify(added.data));
  const folderJob = await waitJob((await api('GET', '/api/ingest')).data.find((j) => j.displayName === 'procedures.txt')?.id);
  check('a document in the folder is filed', folderJob?.status === 'done' && folderJob.folderLabel === 'Ops share' && folderJob.relPath === 'Safety/procedures.txt', JSON.stringify(folderJob));
  let fSet = (await getPage('team/onboarding')).pending.find((p) => p.source?.filename === 'procedures.txt');
  check('its source names the folder and the path inside it', fSet?.source?.folderLabel === 'Ops share' && fSet.source.relPath === 'Safety/procedures.txt' && fSet.source.version === 1);
  check('the full server path never appears in sources', !JSON.stringify(await getPage('team/onboarding')).includes(watchDir));
  await api('POST', `/api/proposals/${fSet.proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  check('the approval names the folder file', git('log', '-1', '--format=%B').includes('procedures.txt (Ops share: Safety/procedures.txt, version 1, from Alex'), git('log', '-1', '--format=%B'));
  const folderId = added.data.id;
  check('an unchanged folder sends nothing', (await api('POST', `/api/folders/${folderId}/scan`)).data.queued === 0);
  const past = new Date(Date.now() - 30_000);
  fs.utimesSync(path.join(watchDir, 'Safety/procedures.txt'), past, past);
  check('a file that was only touched sends nothing', (await api('POST', `/api/folders/${folderId}/scan`)).data.queued === 0);
  writeOld('Safety/procedures.txt', 'FACT: The fire drill is in April.\n');
  check('a changed file is sent again', (await api('POST', `/api/folders/${folderId}/scan`)).data.queued === 1);
  const changedJob = await waitJob((await api('GET', '/api/ingest')).data.find((j) => j.displayName === 'procedures.txt' && j.status !== 'done' && j.status !== 'skipped')?.id
    ?? (await api('GET', '/api/ingest')).data[0].id);
  fSet = (await getPage('team/onboarding')).pending.find((p) => p.source?.filename === 'procedures.txt');
  check('the changed file is filed as version 2', changedJob?.status === 'done' && fSet?.source?.version === 2, JSON.stringify({ changedJob, src: fSet?.source }));
  if (fSet) await api('POST', `/api/proposals/${fSet.proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  writeOld('Safety/fresh.txt', 'FACT: First aid kits are by each exit.\n');
  const quiet = await api('POST', '/api/folders', { label: 'Quiet share', path: watchDir, user: 'Alex', fileExisting: false });
  check('a folder can start without filing what is already there', quiet.status === 200 && quiet.data.fileCount === 2 && !(await api('GET', '/api/ingest')).data.some((j) => j.folderLabel === 'Quiet share'));
  writeOld('Safety/new-rule.txt', 'FACT: Visitors sign in at reception.\n');
  check('later documents in that folder are filed', (await api('POST', `/api/folders/${quiet.data.id}/scan`)).data.queued === 1);
  check('a missing folder is refused clearly', /cannot find the folder/.test((await api('POST', '/api/folders', { label: 'Nope', path: '/no/such/dir', user: 'Alex' })).data.error ?? ''));
  check('the same label cannot be used twice', (await api('POST', '/api/folders', { label: 'Ops share', path: watchDir, user: 'Alex' })).status === 400);
  await waitJob((await api('GET', '/api/ingest')).data[0].id);
  for (const f of (await api('GET', '/api/folders')).data) await api('DELETE', `/api/folders/${f.id}`);
  check('folders can stop being watched', (await api('GET', '/api/folders')).data.length === 0);
  for (const p of (await getPage('team/onboarding')).pending) await api('POST', `/api/proposals/${p.proposalId}/resolve`, { action: 'reject', user: 'Kim' });
  fs.rmSync(watchDir, { recursive: true, force: true });

  // 24. Search finds approved content
  const hits = (await api('GET', '/api/search?q=nightly')).data;
  check('search finds approved content', hits.some((h) => h.path === 'systems/backup-policy'));
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
process.exit(failures ? 1 : 0);
