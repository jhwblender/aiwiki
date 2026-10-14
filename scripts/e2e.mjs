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
import { startMock } from './mock-llm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 3100;
const MOCK_PORT = 4555;
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
const chat = (text, user = 'Alex') =>
  api('POST', '/api/chat', { messages: [{ role: 'user', content: text }], provider: 'local', user }).then((r) => r.data);
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

  // 5. New page proposal, approved with Approve all
  await chat('Write up our backup schedule');
  const bp = await getPage('systems/backup-policy');
  check('new page is pending but not live', !bp.exists && bp.pending.length === 1 && bp.pending[0].isNew);
  check('sidebar shows the new page', (await api('GET', '/api/pages')).data.some((p) => p.path === 'systems/backup-policy' && p.isNew));
  await api('POST', `/api/proposals/${bp.pending[0].proposalId}/resolve`, { action: 'approve', user: 'Kim' });
  const bp2 = await getPage('systems/backup-policy');
  check('approve all publishes the new page', bp2.exists && bp2.title === 'Backup policy' && bp2.pending.length === 0);
  check('resolved proposal cannot be decided twice',
    (await api('POST', `/api/proposals/${bp.pending[0].proposalId}/resolve`, { action: 'approve', user: 'Kim' })).status === 400);

  // 6. Reject all leaves the page alone
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

  // 7. Human edits publish immediately under the editor's name
  const put = await api('PUT', '/api/page', { path: 'systems/onboarding', content: before + '\nEdited by hand.\n', user: 'Jordan' });
  check('human edit saves', put.status === 200);
  check('human edit is live', pageFile('systems/onboarding').includes('Edited by hand.'));
  check('human edit commit author', git('log', '-1', '--format=%an').trim() === 'Jordan');

  // 8. Search finds approved content
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
