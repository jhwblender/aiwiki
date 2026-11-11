import { spawn } from 'node:child_process';
import simpleGit, { type SimpleGit } from 'simple-git';
import { WIKI_DIR } from './db';
import { ensureInit, listPages, readPage, writePage, deletePage, titleFor } from './wiki';
import { rebase } from './diff';
import { movePageWithRecords } from './proposals';
import type { HistoryAction, HistoryEntry } from './types';

// The journal of approvals. Every suggestion a person approved was published as a change in the
// wiki's history, named after the approver and the change set it came from; this reads that
// journal and undoes an approval by putting back what it changed. An undo never writes over
// anything done since: every part is checked first, and the whole undo is refused when a page
// has changed in the same place, so nothing newer is lost.

// Opened on first use, once the wiki folder exists: building the app loads this file before any
// wiki has been set up
let opened: SimpleGit | null = null;
async function git(): Promise<SimpleGit> {
  await ensureInit();
  return (opened ??= simpleGit(WIKI_DIR));
}

const SEP = '\u001e'; // between commits in the log
const US = '\u001f'; // between fields of one commit
const LOG_FORMAT = `${SEP}%H${US}%cI${US}%an${US}%s${US}%b`;
const FILE_LINE = /^([AMDRC])\d*\t(.+)$/;
// Approvals are sparse among ordinary edits, so a generous window is read and filtered
const WINDOW = 2000;
const SHOWN = 100;

type Parsed = {
  commit: string;
  at: string;
  approver: string;
  summary: string;
  changeSet: number;
  files: { status: 'A' | 'M' | 'D' | 'R'; from: string; to: string }[];
};

// The log as records: each commit's details, then the files it touched. Only commits that name a
// change set are approvals; a person's own edits and undos are left out.
function parseLog(out: string): Parsed[] {
  const parsed: Parsed[] = [];
  for (const chunk of out.split(SEP)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    const firstFile = lines.findIndex((l) => FILE_LINE.test(l));
    if (firstFile < 1) continue;
    const meta = lines.slice(0, firstFile).join('\n').split(US);
    if (meta.length < 5) continue;
    const [commit, at, approver, summary, ...body] = meta;
    const m = [...body, summary ?? ''].join('\n').match(/Change set: #(\d+)/);
    if (!m) continue;
    const files: Parsed['files'] = [];
    for (const line of lines.slice(firstFile)) {
      const f = line.match(FILE_LINE);
      if (!f) continue;
      const parts = f[2].split('\t');
      files.push({ status: f[1] as Parsed['files'][number]['status'], from: parts[0].replace(/\.md$/, ''), to: (parts[1] ?? parts[0]).replace(/\.md$/, '') });
    }
    if (files.length) parsed.push({ commit, at, approver, summary: summary ?? '', changeSet: Number(m[1]), files });
  }
  return parsed;
}

// Read many blobs from git's object store in one go, so a long list of history does not spawn a
// process per page. Asked for in order and answered in order.
function readBlobs(refs: string[]): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, string>();
    if (!refs.length) return resolve(out);
    const queue = [...refs];
    const child = spawn('git', ['cat-file', '--batch'], { cwd: WIKI_DIR });
    let buf = Buffer.alloc(0);
    const take = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const header = buf.subarray(0, nl).toString('utf8');
        const hit = header.match(/^[0-9a-f]{40,64} (?:blob|tree|commit) (\d+)$/);
        if (hit) {
          const size = Number(hit[1]);
          if (buf.length < nl + 2 + size) return;
          out.set(queue.shift() ?? '', buf.subarray(nl + 1, nl + 1 + size).toString('utf8'));
          buf = buf.subarray(nl + 2 + size);
        } else if (header.endsWith(' missing')) {
          queue.shift();
          buf = buf.subarray(nl + 1);
        } else {
          child.kill();
          reject(new Error('Could not read the wiki history.'));
          return;
        }
      }
    };
    child.stdout.on('data', take);
    child.stdout.on('end', () => (queue.length ? reject(new Error('Could not read the wiki history.')) : resolve(out)));
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.stdin.write(refs.join('\n') + '\n');
    child.stdin.end();
  });
}

async function blobAt(ref: string): Promise<string | undefined> {
  try {
    return await (await git()).raw(['show', ref]);
  } catch {
    return undefined;
  }
}

function refFor(c: Parsed, f: Parsed['files'][number]): string {
  return `${c.commit}${f.status === 'A' || f.status === 'M' ? ':' : '^:'}${f.from}.md`;
}

// The approvals themselves: pages created, removed and moved for the whole wiki, or everything
// that touched one page with ?page= (its edits included).
export async function approvalHistory(page?: string): Promise<{ entries: HistoryEntry[]; more: boolean }> {
  const out = await (await git()).raw(['log', '-M', '--name-status', `--format=${LOG_FORMAT}`, `--max-count=${WINDOW}`]);
  const all = parseLog(out);
  const wanted = page
    ? all.filter((c) => c.files.some((f) => f.from === page || f.to === page))
    : all.filter((c) => c.files.some((f) => f.status !== 'M'));
  const shown = wanted.slice(0, SHOWN);
  const refs = [...new Set(shown.flatMap((c) => c.files.map((f) => refFor(c, f))))];
  const blobs = await readBlobs(refs);
  const paths = new Set((await listPages()).map((p) => p.path));
  const entries: HistoryEntry[] = shown.map((c) => ({
    commit: c.commit,
    at: c.at,
    approver: c.approver,
    summary: c.summary,
    changeSet: c.changeSet,
    // Wiki-wide, an entry shows what it did to pages' places; the link rewrites that came with a
    // move are the move's own doing, so only the page view lists them
    actions: c.files
      .map((f): HistoryAction => {
        const kind: HistoryAction['kind'] = f.status === 'A' ? 'created' : f.status === 'D' ? 'removed' : f.status === 'M' ? 'edited' : 'moved';
        const content = blobs.get(refFor(c, f));
        return {
          kind,
          path: f.from,
          newPath: kind === 'moved' ? f.to : undefined,
          title: content !== undefined ? titleFor(content, f.from) : titleFor('', f.from),
          newTitle: kind === 'moved' ? titleFor('', f.to) : undefined,
          exists: kind === 'moved' ? paths.has(f.to) : paths.has(f.from),
        };
      })
      .filter((a) => page || a.kind !== 'edited'),
  }));
  return { entries, more: wanted.length > SHOWN };
}

// Undo one approval. Each part is checked before anything is written, so a stale undo is refused
// as a whole instead of half applied.
// The pages one approval touched, so a route can check the person may undo it there
export async function pagesOfApproval(commit: string): Promise<string[]> {
  if (!/^[0-9a-f]{6,64}$/.test(commit)) return [];
  try {
    const c = parseLog(await (await git()).raw(['log', '-M', '--name-status', `--format=${LOG_FORMAT}`, '-n', '1', commit]))[0];
    return c ? [...new Set(c.files.flatMap((f) => [f.from, f.to]))] : [];
  } catch {
    return [];
  }
}

export async function undoApproval(commit: string, user: string): Promise<void> {
  if (!/^[0-9a-f]{6,64}$/.test(commit)) throw new Error('That approval was not found.');
  let c: Parsed | undefined;
  try {
    c = parseLog(await (await git()).raw(['log', '-M', '--name-status', `--format=${LOG_FORMAT}`, '-n', '1', commit]))[0];
  } catch {
    throw new Error('That approval was not found.');
  }
  if (!c || !c.changeSet) throw new Error('Only a change approved from a suggestion can be undone.');

  // A move approval moved a page and everything under it, and rewrote the links to it; moving it
  // back does the same in reverse
  if (c.files.some((f) => f.status === 'R')) {
    const moves = c.files.filter((f) => f.status === 'R');
    // The page that was moved; sub-pages came along with it
    const primary = moves.reduce((a, b) => (a.from.split('/').length <= b.from.split('/').length ? a : b));
    const title = titleFor((await blobAt(`${commit}^:${primary.from}.md`)) ?? '', primary.from);
    if ((await readPage(primary.from)) !== null) throw new Error(`A page exists at "${primary.from}" again, so the move cannot be undone.`);
    if ((await readPage(primary.to)) === null) throw new Error(`The page is no longer at "${primary.to}", so the move cannot be undone.`);
    const under = (await listPages())
      .filter((p) => p.path === primary.to || p.path.startsWith(primary.to + '/'))
      .map((p) => p.path)
      .sort();
    const expected = [...new Set(moves.map((m) => m.to))].sort();
    if (JSON.stringify(under) !== JSON.stringify(expected))
      throw new Error('Pages under it changed since the move, so it cannot be undone automatically.');
    await movePageWithRecords(primary.to, primary.from, user, `Undo an approved move: "${title}" goes back where it was.`);
    return;
  }

  const planned: (() => Promise<void>)[] = [];
  for (const f of c.files) {
    const title = titleFor((await blobAt(refFor(c, f))) ?? '', f.from);
    if (f.status === 'D') {
      if ((await readPage(f.from)) !== null) throw new Error(`"${title}" exists again, so there is nothing to bring back.`);
      const content = await blobAt(`${commit}^:${f.from}.md`);
      if (content === undefined) throw new Error(`"${title}" cannot be read from the history, so it cannot be brought back.`);
      planned.push(() => writePage(f.from, content, user, `Undo an approved removal: put "${title}" back.`));
    } else if (f.status === 'A') {
      const live = await readPage(f.from);
      if (live === null) throw new Error(`"${title}" is gone already, so there is nothing to undo.`);
      if (live !== (await blobAt(`${commit}:${f.from}.md`)))
        throw new Error(`"${title}" changed since it was approved, so it stays. Remove it by hand if you want.`);
      planned.push(() => deletePage(f.from, user, `Undo an approved creation: remove "${title}".`));
    } else if (f.status === 'M') {
      const live = await readPage(f.from);
      if (live === null) throw new Error(`"${title}" no longer exists, so the edit cannot be undone.`);
      const oldText = await blobAt(`${commit}^:${f.from}.md`);
      const newText = await blobAt(`${commit}:${f.from}.md`);
      if (oldText === undefined || newText === undefined)
        throw new Error(`"${title}" cannot be read from the history, so the edit cannot be undone.`);
      // Replay the approved edit backwards onto the page as it is now; a clash with anything
      // written since refuses the undo rather than writing over it
      const undone = rebase(newText, oldText, live);
      if (undone === null)
        throw new Error(`"${title}" changed in the same place since this was approved, so the edit cannot be undone. Ask the assistant to change it instead.`);
      planned.push(() => writePage(f.from, undone, user, `Undo an approved edit on "${title}".`));
    }
  }
  for (const step of planned) await step();
}