import { db } from './db';
import { changed } from './pulse';
import { deletePage, movePage, planMove, readPage, rewriteLinks, writePage, titleFor } from './wiki';
import { fromBlocks, hunkCount, normalize, rebase, resolveHunk, segments, toBlocks } from './diff';
import type { PageSourceRef, PendingOp, PendingSet, SourceInfo } from './types';

const now = () => new Date().toISOString();

// ---------- sources ----------

export function createSource(input: {
  kind: 'chat' | 'file' | 'manual' | 'librarian';
  user: string;
  folderLabel?: string;
  relPath?: string;
  filename?: string;
  contentHash?: string;
  version?: number;
  storedPath?: string;
  note?: string;
}): number {
  const r = db()
    .prepare(
      `INSERT INTO sources (kind, user, folder_label, rel_path, filename, content_hash, version, stored_path, note, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.kind,
      input.user,
      input.folderLabel ?? null,
      input.relPath ?? null,
      input.filename ?? null,
      input.contentHash ?? null,
      input.version ?? 1,
      input.storedPath ?? null,
      input.note ?? null,
      now(),
    );
  return Number(r.lastInsertRowid);
}

function rowToSource(r: any): SourceInfo | null {
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    user: r.user,
    folderLabel: r.folder_label,
    relPath: r.rel_path,
    filename: r.filename,
    contentHash: r.content_hash,
    version: r.version,
    note: r.note,
    detectedAt: r.detected_at,
    hasFile: r.kind === 'file' && !!r.stored_path,
  };
}

export function getSource(id: number | null): SourceInfo | null {
  if (id == null) return null;
  return rowToSource(db().prepare('SELECT * FROM sources WHERE id = ?').get(id));
}

// ---------- staging (used by the AI tools) ----------

export function createChangeSet(sourceId: number, summary: string, createdBy: string, chatId?: string): number {
  const r = db()
    .prepare('INSERT INTO change_sets (source_id, summary, created_by, created_at, chat_id) VALUES (?, ?, ?, ?, ?)')
    .run(sourceId, summary, createdBy, now(), chatId ?? null);
  return Number(r.lastInsertRowid);
}

// A message with several files: the change set's first file is its main source, the rest are linked here
export function linkExtraSource(changeSetId: number, sourceId: number) {
  db().prepare('INSERT OR IGNORE INTO change_set_sources (change_set_id, source_id) VALUES (?, ?)').run(changeSetId, sourceId);
}

function extraSourceIds(changeSetId: number): number[] {
  return (db().prepare('SELECT source_id FROM change_set_sources WHERE change_set_id = ? ORDER BY source_id').all(changeSetId) as { source_id: number }[]).map(
    (r) => r.source_id,
  );
}

// The newest pending suggestion for a page made earlier in the same chat by the same person,
// brought up to date with the live page. null if there is none or it no longer fits the page.
export async function chatPending(
  chatId: string,
  user: string,
  pagePath: string,
  excludeChangeSetId: number | null,
): Promise<{ proposalId: number; content: string; isNew: boolean } | null> {
  const row = db()
    .prepare(
      `SELECT p.id, p.new_content, p.base_content, p.is_new FROM proposals p
       JOIN change_sets cs ON cs.id = p.change_set_id JOIN sources s ON s.id = cs.source_id
       WHERE p.page_path = ? AND p.status = 'pending' AND cs.chat_id = ? AND s.user = ? AND cs.id IS NOT ?
       ORDER BY p.id DESC LIMIT 1`,
    )
    .get(pagePath, chatId, user, excludeChangeSetId) as { id: number; new_content: string; base_content: string | null; is_new: number } | undefined;
  if (!row) return null;
  const content = current(row, (await readPage(pagePath)) ?? '');
  return content === null ? null : { proposalId: row.id, content, isNew: !!row.is_new };
}

// Retire a suggestion that a later message in the same chat replaced.
export function supersede(oldProposalId: number, newChangeSetId: number, pagePath: string, user: string) {
  changed();
  const d = db();
  const next = d.prepare('SELECT id FROM proposals WHERE change_set_id = ? AND page_path = ?').get(newChangeSetId, pagePath) as
    | { id: number }
    | undefined;
  d.prepare("UPDATE proposals SET status = 'superseded', superseded_by = ? WHERE id = ? AND status = 'pending'").run(next?.id ?? null, oldProposalId);
  d.prepare('INSERT INTO decisions (proposal_id, action, scope, user, at) VALUES (?, ?, ?, ?, ?)').run(oldProposalId, 'supersede', 'all', user, now());
}

// Sources of the suggestions this proposal replaced, oldest first.
function earlierSourceIds(proposalId: number): number[] {
  const out: number[] = [];
  let ids = [proposalId];
  for (let depth = 0; depth < 20 && ids.length; depth++) {
    const rows = db()
      .prepare(
        `SELECT p.id, cs.source_id FROM proposals p JOIN change_sets cs ON cs.id = p.change_set_id
         WHERE p.superseded_by IN (${ids.map(() => '?').join(',')}) ORDER BY p.id DESC`,
      )
      .all(...ids) as { id: number; source_id: number }[];
    out.unshift(...rows.map((r) => r.source_id).reverse());
    ids = rows.map((r) => r.id);
  }
  return [...new Set(out)];
}

// What this change set has staged for a page, or null if it has not touched it.
export function stagedContent(changeSetId: number, pagePath: string): string | null {
  const row = db()
    .prepare("SELECT new_content FROM proposals WHERE change_set_id = ? AND page_path = ? AND status = 'pending'")
    .get(changeSetId, pagePath) as { new_content: string } | undefined;
  return row ? row.new_content : null;
}

// Returns false when the text equals the live page, so there is nothing left to suggest
export async function stageContent(changeSetId: number, pagePath: string, newContent: string): Promise<boolean> {
  const live = await readPage(pagePath);
  const content = normalize(newContent);
  const d = db();
  if (live !== null && normalize(live) === content) {
    d.prepare('DELETE FROM proposals WHERE change_set_id = ? AND page_path = ?').run(changeSetId, pagePath);
    changed();
    return false;
  }
  d.prepare(
    `INSERT INTO proposals (change_set_id, page_path, new_content, base_content, is_new, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT (change_set_id, page_path) DO UPDATE SET new_content = excluded.new_content, status = 'pending'`,
  ).run(changeSetId, pagePath, content, normalize(live ?? ''), live === null ? 1 : 0, now());
  changed();
  return true;
}

// Bring a suggestion up to date with the live page. Saves the rebased text so later
// fingerprints match what the reviewer saw. Returns null content on a conflict.
function current(p: { id: number; new_content: string; base_content: string | null }, live: string): string | null {
  if (p.base_content === null || normalize(p.base_content) === normalize(live)) return p.new_content;
  const next = rebase(p.base_content, p.new_content, live);
  if (next !== null) {
    db().prepare('UPDATE proposals SET new_content = ?, base_content = ? WHERE id = ?').run(next, normalize(live), p.id);
    p.new_content = next;
    p.base_content = normalize(live);
  }
  return next;
}

// ---------- reading pending work ----------

export async function pendingForPage(pagePath: string): Promise<PendingSet[]> {
  const rows = db()
    .prepare(
      `SELECT p.id AS proposal_id, p.new_content, p.base_content, p.is_new, cs.id AS change_set_id, cs.summary, cs.created_by,
              cs.created_at, cs.source_id
       FROM proposals p JOIN change_sets cs ON cs.id = p.change_set_id
       WHERE p.page_path = ? AND p.status = 'pending' ORDER BY p.id`,
    )
    .all(pagePath) as any[];
  if (!rows.length) return [];
  const live = (await readPage(pagePath)) ?? '';
  const out: PendingSet[] = [];
  for (const r of rows) {
    const content = current({ id: r.proposal_id, new_content: r.new_content, base_content: r.base_content }, live);
    const conflict = content === null;
    const segs = conflict ? segments(r.base_content, r.new_content) : segments(live, content);
    if (hunkCount(segs) === 0) {
      db().prepare("UPDATE proposals SET status = 'resolved' WHERE id = ?").run(r.proposal_id);
      continue;
    }
    out.push({
      proposalId: r.proposal_id,
      changeSetId: r.change_set_id,
      summary: r.summary,
      createdBy: r.created_by,
      createdAt: r.created_at,
      isNew: !!r.is_new && live === '',
      conflict,
      source: getSource(r.source_id),
      earlierSources: earlierSourceIds(r.proposal_id).map((id) => getSource(id)!).filter(Boolean),
      alsoSources: extraSourceIds(r.change_set_id).map((id) => getSource(id)!).filter(Boolean),
      segments: segs,
    });
  }
  return out;
}

export function pendingCounts(): Map<string, { count: number; isNew: boolean; title: string }> {
  const rows = db()
    .prepare(
      `SELECT page_path, COUNT(*) AS n, MAX(is_new) AS is_new, MAX(CASE WHEN is_new = 1 THEN new_content END) AS new_content
       FROM proposals WHERE status = 'pending' GROUP BY page_path`,
    )
    .all() as { page_path: string; n: number; is_new: number; new_content: string | null }[];
  const out = new Map(
    rows.map((r) => [r.page_path, { count: r.n, isNew: !!r.is_new, title: titleFor(r.new_content ?? '', r.page_path) }]),
  );
  const ops = db().prepare("SELECT page_path, COUNT(*) AS n FROM page_ops WHERE status = 'pending' GROUP BY page_path").all() as {
    page_path: string;
    n: number;
  }[];
  for (const o of ops) {
    const cur = out.get(o.page_path);
    if (cur) cur.count += o.n;
    else out.set(o.page_path, { count: o.n, isNew: false, title: titleFor('', o.page_path) });
  }
  return out;
}

export function sourcesForPage(pagePath: string): PageSourceRef[] {
  const rows = db()
    .prepare(
      `SELECT ps.approved_by, ps.approved_at, s.* FROM page_sources ps
       JOIN sources s ON s.id = ps.source_id
       WHERE ps.page_path = ? ORDER BY ps.approved_at DESC`,
    )
    .all(pagePath) as any[];
  const seen = new Set<number>();
  const out: PageSourceRef[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ source: rowToSource(r)!, approvedBy: r.approved_by, approvedAt: r.approved_at });
  }
  return out;
}

export function sourceLabel(s: SourceInfo | null): string {
  if (!s) return 'unknown source';
  if (s.kind === 'chat') return `chat with ${s.user}`;
  if (s.kind === 'librarian') return `librarian${s.note ? ` (${s.note.toLowerCase()})` : ''}, started by ${s.user}`;
  if (s.kind === 'file') {
    const where = s.folderLabel ? `${s.folderLabel}: ${s.relPath ?? s.filename}, ` : '';
    return `${s.filename ?? 'file'} (${where}version ${s.version}, from ${s.user}${s.contentHash ? `, content ${s.contentHash.slice(0, 12)}` : ''})`;
  }
  return s.user;
}

// ---------- moving pages ----------

// Move pages (a person's move, or an approved suggestion) and carry their pending
// suggestions and recorded sources along. Links inside pending suggestions are rewritten too,
// in both the suggested text and the text it was written against, so they still line up.
export async function movePageWithRecords(from: string, to: string, user: string, message: string) {
  const moves = await movePage(from, to, user, message);
  const d = db();
  for (const [oldPath, newPath] of moves) {
    d.prepare("UPDATE proposals SET page_path = ? WHERE page_path = ? AND status = 'pending'").run(newPath, oldPath);
    d.prepare('UPDATE page_sources SET page_path = ? WHERE page_path = ?').run(newPath, oldPath);
    d.prepare("UPDATE page_ops SET page_path = ? WHERE page_path = ? AND status = 'pending'").run(newPath, oldPath);
  }
  const rows = d.prepare("SELECT id, new_content, base_content FROM proposals WHERE status = 'pending'").all() as {
    id: number;
    new_content: string;
    base_content: string | null;
  }[];
  for (const r of rows) {
    const next = rewriteLinks(r.new_content, from, to);
    const base = r.base_content === null ? null : rewriteLinks(r.base_content, from, to);
    if (next !== r.new_content || base !== r.base_content) {
      d.prepare('UPDATE proposals SET new_content = ?, base_content = ? WHERE id = ?').run(next, base, r.id);
    }
  }
  return moves;
}

// ---------- structural suggestions (move, remove) ----------

export function stageOp(changeSetId: number, kind: 'move' | 'remove', pagePath: string, newPath: string | null): number {
  changed();
  const r = db()
    .prepare("INSERT INTO page_ops (change_set_id, kind, page_path, new_path, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
    .run(changeSetId, kind, pagePath, newPath, now());
  return Number(r.lastInsertRowid);
}

// This chat's pending move or removal of a page, so a follow-up message can replace it
export function chatPendingOp(chatId: string, user: string, pagePath: string, excludeChangeSetId: number | null): number | null {
  const row = db()
    .prepare(
      `SELECT o.id FROM page_ops o JOIN change_sets cs ON cs.id = o.change_set_id JOIN sources s ON s.id = cs.source_id
       WHERE o.page_path = ? AND o.status = 'pending' AND cs.chat_id = ? AND s.user = ? AND cs.id IS NOT ?
       ORDER BY o.id DESC LIMIT 1`,
    )
    .get(pagePath, chatId, user, excludeChangeSetId) as { id: number } | undefined;
  return row?.id ?? null;
}

export function supersedeOp(opId: number) {
  changed();
  db().prepare("UPDATE page_ops SET status = 'superseded' WHERE id = ? AND status = 'pending'").run(opId);
}

async function staleReason(kind: string, pagePath: string, newPath: string | null): Promise<string | null> {
  if (kind === 'remove') return (await readPage(pagePath)) === null ? 'This page no longer exists.' : null;
  try {
    await planMove(pagePath, newPath ?? '');
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

type OpRow = { id: number; change_set_id: number; kind: 'move' | 'remove'; page_path: string; new_path: string | null; status: string };

export async function pendingOpsForPage(pagePath: string): Promise<PendingOp[]> {
  const rows = db()
    .prepare(
      `SELECT o.*, cs.summary, cs.created_by, cs.created_at AS cs_created, cs.source_id FROM page_ops o
       JOIN change_sets cs ON cs.id = o.change_set_id WHERE o.page_path = ? AND o.status = 'pending' ORDER BY o.id`,
    )
    .all(pagePath) as (OpRow & { summary: string; created_by: string; cs_created: string; source_id: number })[];
  const out: PendingOp[] = [];
  for (const r of rows) {
    out.push({
      opId: r.id,
      changeSetId: r.change_set_id,
      kind: r.kind,
      newPath: r.new_path,
      summary: r.summary,
      createdBy: r.created_by,
      createdAt: r.cs_created,
      source: getSource(r.source_id),
      stale: await staleReason(r.kind, r.page_path, r.new_path),
    });
  }
  return out;
}

function opMessage(r: OpRow, user: string): string {
  const cs = db().prepare('SELECT summary, source_id FROM change_sets WHERE id = ?').get(r.change_set_id) as any;
  const src = getSource(cs?.source_id ?? null);
  return `${cs?.summary ?? (r.kind === 'move' ? 'Move page' : 'Remove page')}\n\nSource: ${sourceLabel(src)} (source #${src?.id ?? '?'})\nChange set: #${r.change_set_id}\nApproved by: ${user}`;
}

export async function decideOp(opId: number, action: 'approve' | 'reject', user: string): Promise<{ path: string | null }> {
  const d = db();
  const r = d.prepare('SELECT * FROM page_ops WHERE id = ?').get(opId) as OpRow | undefined;
  if (!r) throw new Error('Suggestion not found');
  if (r.status !== 'pending') throw new Error('This change was already resolved');
  let path: string | null = r.page_path;
  if (action === 'approve') {
    const stale = await staleReason(r.kind, r.page_path, r.new_path);
    if (stale) throw new Error(`${stale} Reject this suggestion instead.`);
  }
  // Record the decision before acting, so a failure part way cannot leave a done change without a record
  d.prepare('INSERT INTO op_decisions (op_id, action, user, at) VALUES (?, ?, ?, ?)').run(opId, action, user, now());
  if (action === 'approve') {
    const cs = d.prepare('SELECT source_id FROM change_sets WHERE id = ?').get(r.change_set_id) as { source_id: number };
    if (r.kind === 'move') {
      await movePageWithRecords(r.page_path, r.new_path!, user, opMessage(r, user));
      path = r.new_path;
    } else {
      await deletePage(r.page_path, user, opMessage(r, user));
      // Suggestions to edit a page that is gone can no longer apply
      d.prepare("UPDATE proposals SET status = 'resolved' WHERE page_path = ? AND status = 'pending'").run(r.page_path);
      path = null;
    }
    if (path) d.prepare('INSERT INTO page_sources (page_path, source_id, approved_by, approved_at) VALUES (?, ?, ?, ?)').run(path, cs.source_id, user, now());
  }
  d.prepare("UPDATE page_ops SET status = 'resolved' WHERE id = ?").run(opId);
  changed();
  return { path };
}

// ---------- deciding ----------

type ProposalRow = {
  id: number;
  change_set_id: number;
  page_path: string;
  new_content: string;
  base_content: string | null;
  status: string;
};

const STALE = 'The page changed in the same place after this was suggested. Reject it and ask the assistant again.';

function loadProposal(id: number): ProposalRow {
  const r = db().prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined;
  if (!r) throw new Error('Proposal not found');
  if (r.status !== 'pending') throw new Error('This change was already resolved');
  return r;
}

function log(proposalId: number, action: 'approve' | 'reject', scope: 'hunk' | 'all', user: string) {
  db().prepare('INSERT INTO decisions (proposal_id, action, scope, user, at) VALUES (?, ?, ?, ?, ?)').run(
    proposalId, action, scope, user, now(),
  );
}

// Every message that shaped the suggestion: the ones it revised, then its own
function allSourceIds(p: ProposalRow): number[] {
  const cs = db().prepare('SELECT source_id FROM change_sets WHERE id = ?').get(p.change_set_id) as { source_id: number } | undefined;
  return [...new Set([...earlierSourceIds(p.id), ...(cs?.source_id ? [cs.source_id] : []), ...extraSourceIds(p.change_set_id)])];
}

function recordSource(p: ProposalRow, user: string) {
  for (const sourceId of allSourceIds(p)) {
    db()
      .prepare('INSERT INTO page_sources (page_path, source_id, approved_by, approved_at) VALUES (?, ?, ?, ?)')
      .run(p.page_path, sourceId, user, now());
  }
}

function commitMessage(p: ProposalRow, user: string): string {
  const cs = db().prepare('SELECT summary FROM change_sets WHERE id = ?').get(p.change_set_id) as any;
  const sources = allSourceIds(p)
    .map((id) => getSource(id))
    .map((src) => `Source: ${sourceLabel(src)} (source #${src?.id ?? '?'})`);
  return `${cs?.summary ?? 'AI change'}\n\n${sources.join('\n') || 'Source: unknown'}\nChange set: #${p.change_set_id}\nApproved by: ${user}`;
}

export async function decideHunk(proposalId: number, index: number, fp: string, action: 'approve' | 'reject', user: string) {
  const p = loadProposal(proposalId);
  const live = (await readPage(p.page_path)) ?? '';
  const content = current(p, live);
  if (content === null) throw new Error(STALE);
  const seg = segments(live, content).find((s) => s.type === 'change' && s.index === index);
  if (!seg || seg.type !== 'change' || seg.fp !== fp) throw new Error('This page changed since you loaded it. Reload and try again.');
  const r = resolveHunk(live, content, index, action);
  if (action === 'approve') {
    await writePage(p.page_path, r.current, user, commitMessage(p, user));
    recordSource(p, user);
  }
  const base = action === 'approve' ? r.current : live;
  db().prepare('UPDATE proposals SET new_content = ?, base_content = ? WHERE id = ?').run(r.proposed, normalize(base), p.id);
  log(p.id, action, 'hunk', user);
  const left = hunkCount(segments(action === 'approve' ? r.current : live, r.proposed));
  if (left === 0) db().prepare("UPDATE proposals SET status = 'resolved' WHERE id = ?").run(p.id);
  changed();
}

export async function decideAll(proposalId: number, action: 'approve' | 'reject', user: string) {
  const p = loadProposal(proposalId);
  if (action === 'approve') {
    const content = current(p, (await readPage(p.page_path)) ?? '');
    if (content === null) throw new Error(STALE);
    await writePage(p.page_path, fromBlocks(toBlocks(content)), user, commitMessage(p, user));
    recordSource(p, user);
  }
  db().prepare("UPDATE proposals SET status = 'resolved' WHERE id = ?").run(p.id);
  log(p.id, action, 'all', user);
  changed();
}

export { titleFor };
