import { db } from './db';
import { readPage, writePage, titleFor } from './wiki';
import { fromBlocks, hunkCount, normalize, rebase, resolveHunk, segments, toBlocks } from './diff';
import type { PageSourceRef, PendingSet, SourceInfo } from './types';

const now = () => new Date().toISOString();

// ---------- sources ----------

export function createSource(input: {
  kind: 'chat' | 'file' | 'manual';
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
  };
}

export function getSource(id: number | null): SourceInfo | null {
  if (id == null) return null;
  return rowToSource(db().prepare('SELECT * FROM sources WHERE id = ?').get(id));
}

// ---------- staging (used by the AI tools) ----------

export function createChangeSet(sourceId: number, summary: string, createdBy: string): number {
  const r = db()
    .prepare('INSERT INTO change_sets (source_id, summary, created_by, created_at) VALUES (?, ?, ?, ?)')
    .run(sourceId, summary, createdBy, now());
  return Number(r.lastInsertRowid);
}

// Content the page would have if this change set were approved as-is.
export async function workingContent(changeSetId: number, pagePath: string): Promise<{ content: string; exists: boolean }> {
  const row = db()
    .prepare('SELECT new_content FROM proposals WHERE change_set_id = ? AND page_path = ?')
    .get(changeSetId, pagePath) as { new_content: string } | undefined;
  if (row) return { content: row.new_content, exists: true };
  const live = await readPage(pagePath);
  return { content: live ?? '', exists: live !== null };
}

export async function stageContent(changeSetId: number, pagePath: string, newContent: string): Promise<void> {
  const live = await readPage(pagePath);
  const content = normalize(newContent);
  const d = db();
  if (live !== null && normalize(live) === content) {
    d.prepare('DELETE FROM proposals WHERE change_set_id = ? AND page_path = ?').run(changeSetId, pagePath);
    return;
  }
  d.prepare(
    `INSERT INTO proposals (change_set_id, page_path, new_content, base_content, is_new, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT (change_set_id, page_path) DO UPDATE SET new_content = excluded.new_content, status = 'pending'`,
  ).run(changeSetId, pagePath, content, normalize(live ?? ''), live === null ? 1 : 0, now());
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
  return new Map(
    rows.map((r) => [r.page_path, { count: r.n, isNew: !!r.is_new, title: titleFor(r.new_content ?? '', r.page_path) }]),
  );
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
  if (s.kind === 'file') return `${s.filename ?? 'file'}${s.folderLabel ? ` (${s.folderLabel})` : ''}`;
  return s.user;
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

function recordSource(p: ProposalRow, user: string) {
  const cs = db().prepare('SELECT source_id FROM change_sets WHERE id = ?').get(p.change_set_id) as { source_id: number } | undefined;
  if (cs?.source_id) {
    db()
      .prepare('INSERT INTO page_sources (page_path, source_id, approved_by, approved_at) VALUES (?, ?, ?, ?)')
      .run(p.page_path, cs.source_id, user, now());
  }
}

function commitMessage(p: ProposalRow, user: string): string {
  const cs = db().prepare('SELECT summary, source_id FROM change_sets WHERE id = ?').get(p.change_set_id) as any;
  const src = getSource(cs?.source_id ?? null);
  return `${cs?.summary ?? 'AI change'}\n\nSource: ${sourceLabel(src)} (source #${src?.id ?? '?'})\nChange set: #${p.change_set_id}\nApproved by: ${user}`;
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
}

export { titleFor };
