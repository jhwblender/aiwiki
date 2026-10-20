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
const chat = (text, user = 'Alex', provider = 'local', chatId = undefined) =>
  api('POST', '/api/chat', { messages: [{ role: 'user', content: text }], provider, user, chatId }).then((r) => r.data);
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
  check('connection test passes against the mock', good.ok === true && good.steps.length === 4 && good.models.includes('mock'), JSON.stringify(good));
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

  // 16. Search finds approved content
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
