// Waits for a moment when the wiki's assistant is not in use, so an update can restart it without
// cutting off a chat reply or a filing job. Runs inside the wiki's server (deploy.sh pipes it into
// docker exec), where it can read the secret the server wrote at startup.
//
// While it waits, the wiki takes no new filing jobs, so the one working can finish. Chats go on as
// usual; it waits for them and for the quiet time after a reply. After WAIT_MINUTES (default 30)
// it gives up, lets filing go again and exits with 1, leaving the running wiki alone.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;
const WAIT_MS = (Number(process.env.WAIT_MINUTES) || 30) * 60 * 1000;
const dataDir = path.resolve(process.env.WIKI_DATA_DIR || './data');
const tag = crypto.createHash('sha256').update(dataDir).digest('hex').slice(0, 12);
let token = '';
try {
  token = fs.readFileSync(path.join(os.tmpdir(), `aiwiki-ops-${tag}`), 'utf8');
} catch {}

async function call(method, body) {
  const r = await fetch(BASE + '/api/restart', {
    method,
    headers: { 'x-ops-token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

function describe(s) {
  const parts = [];
  if (s.chats) parts.push(`${s.chats} chat repl${s.chats === 1 ? 'y' : 'ies'} running`);
  if (s.job) parts.push(`filing job ${s.job.id} working (${s.job.status})`);
  if (s.chatHoldUntil) parts.push(`a chat reply was just given; quiet until ${new Date(s.chatHoldUntil).toLocaleTimeString()}`);
  return parts.join(', ');
}

let first;
try {
  first = await call('POST', { holdMinutes: Math.ceil(WAIT_MS / 60000) + 10 });
} catch {
  console.log('The wiki is not answering; restarting it.');
  process.exit(0);
}
if (first.status === 404 || !token) {
  // A wiki from before this check: there is nothing to ask, so go ahead
  console.log('The running wiki cannot report whether it is busy; restarting it.');
  process.exit(0);
}
if (first.status !== 200) {
  console.error(`The wiki refused the check (${first.status}); not restarting.`);
  process.exit(1);
}

const until = Date.now() + WAIT_MS;
let s = first.data;
let said = '';
while (!s.quiet) {
  const now = describe(s);
  if (now !== said) console.log(`Waiting: ${now}`);
  said = now;
  if (Date.now() > until) {
    await call('POST', { holdMinutes: 0 });
    console.error('The assistant stayed busy; the update is built but the wiki was not restarted. Run the deploy again later.');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 5000));
  s = (await call('GET')).data;
}
console.log('The assistant is not in use; restarting.');
