import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import simpleGit, { SimpleGit } from 'simple-git';
import { db, WIKI_DIR } from './db';

// ---------- paths ----------

export function normalizePath(input: string): string {
  const parts = input
    .replace(/\.md$/i, '')
    .split('/')
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_.]/g, ''))
    .filter((s) => s && s !== '.' && s !== '..');
  if (!parts.length || parts.length > 5) throw new Error('Invalid page path');
  return parts.join('/');
}

function fileFor(p: string) {
  return path.join(WIKI_DIR, p + '.md');
}

export function titleFor(content: string, p: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  const last = p.split('/').pop() || p;
  return last.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// ---------- git (serialised, so concurrent writes never fight over index.lock) ----------

let git: SimpleGit;
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

let ready: Promise<void> | null = null;
export function ensureInit(): Promise<void> {
  if (!ready) ready = init();
  return ready;
}

const SEED: Record<string, string> = {
  index: `# Welcome

This is your team wiki. Edit any page directly, or ask the assistant in the chat panel to add or change things.

Changes the assistant makes are never published straight away. They show up on the page highlighted, and anyone on the team can approve or reject them in place.

Start with [[systems/onboarding]].
`,
  'systems/onboarding': `# Systems team onboarding

New to the systems team? Start here.

## Access

Request VPN access from IT before your first day. Badge access is handled by facilities.

## Tools

The team uses the shared monitoring dashboard and the on-call rotation calendar. Ask your manager to add you to both.
`,
};

async function init() {
  await fs.mkdir(WIKI_DIR, { recursive: true });
  git = simpleGit(WIKI_DIR);
  if (!fsSync.existsSync(path.join(WIKI_DIR, '.git'))) {
    await git.init();
    await git.addConfig('user.name', 'Wiki');
    await git.addConfig('user.email', 'wiki@localhost');
  }
  if ((await listPageFiles()).length === 0) {
    for (const [p, content] of Object.entries(SEED)) {
      await fs.mkdir(path.dirname(fileFor(p)), { recursive: true });
      await fs.writeFile(fileFor(p), content);
    }
    await git.add('.');
    await git.commit('Seed wiki', undefined, { '--author': 'Wiki <wiki@localhost>' });
  }
  const d = db();
  d.prepare('DELETE FROM pages_fts').run();
  for (const p of await listPageFiles()) {
    const content = await fs.readFile(fileFor(p), 'utf8');
    indexPage(p, content);
  }
}

async function listPageFiles(dir = WIKI_DIR, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) out.push(...(await listPageFiles(path.join(dir, e.name), prefix + e.name + '/')));
    else if (e.name.endsWith('.md')) out.push(prefix + e.name.slice(0, -3));
  }
  return out.sort();
}

function indexPage(p: string, content: string) {
  const d = db();
  d.prepare('DELETE FROM pages_fts WHERE path = ?').run(p);
  d.prepare('INSERT INTO pages_fts (path, title, body) VALUES (?, ?, ?)').run(p, titleFor(content, p), content);
}

// ---------- CRUD ----------

export async function listPages(): Promise<{ path: string; title: string }[]> {
  await ensureInit();
  const out = [];
  for (const p of await listPageFiles()) {
    const content = await fs.readFile(fileFor(p), 'utf8');
    out.push({ path: p, title: titleFor(content, p) });
  }
  return out;
}

export async function readPage(p: string): Promise<string | null> {
  await ensureInit();
  try {
    return await fs.readFile(fileFor(p), 'utf8');
  } catch {
    return null;
  }
}

export async function writePage(p: string, content: string, author: string, message: string): Promise<void> {
  await ensureInit();
  await serial(async () => {
    await fs.mkdir(path.dirname(fileFor(p)), { recursive: true });
    await fs.writeFile(fileFor(p), content);
    indexPage(p, content);
    await git.add(p + '.md');
    const who = author.replace(/[<>\n]/g, '').trim() || 'anonymous';
    try {
      await git.commit(message, [p + '.md'], { '--author': `${who} <${who.replace(/\s+/g, '.')}@wiki.local>` });
    } catch {
      // nothing to commit
    }
  });
}

export async function deletePage(p: string, author: string): Promise<void> {
  await ensureInit();
  await serial(async () => {
    await fs.rm(fileFor(p), { force: true });
    db().prepare('DELETE FROM pages_fts WHERE path = ?').run(p);
    await git.add(p + '.md');
    const who = author.replace(/[<>\n]/g, '').trim() || 'anonymous';
    try {
      await git.commit(`Delete ${p}`, [p + '.md'], { '--author': `${who} <${who.replace(/\s+/g, '.')}@wiki.local>` });
    } catch {
      // ignore
    }
  });
}

export async function history(p: string, limit = 20) {
  await ensureInit();
  const log = await git.log({ file: p + '.md', maxCount: limit });
  return log.all.map((l) => ({ hash: l.hash.slice(0, 8), message: l.message, author: l.author_name, date: l.date }));
}

// ---------- search ----------

export async function searchPages(q: string, limit = 8) {
  await ensureInit();
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean);
  if (!terms.length) return [];
  const query = terms.map((t) => `"${t}"*`).join(' ');
  try {
    return db()
      .prepare(
        `SELECT path, title, snippet(pages_fts, 2, '[', ']', '...', 24) AS snippet
         FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(query, limit) as { path: string; title: string; snippet: string }[];
  } catch {
    return [];
  }
}
