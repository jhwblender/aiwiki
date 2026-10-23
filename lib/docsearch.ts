import { db } from './db';
import { toBlocks } from './diff';

// Full-text search over the original documents behind the wiki, so the assistant can find detail
// that was never summarised into a page. The latest version of each document is indexed in parts.

const PART_CHARS = 1500;

export function splitParts(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const block of toBlocks(text)) {
    // A single very long block is cut into pieces
    for (let i = 0; i < block.length; i += PART_CHARS * 2) {
      const piece = block.slice(i, i + PART_CHARS * 2);
      if (cur && cur.length + piece.length > PART_CHARS) {
        out.push(cur);
        cur = '';
      }
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Index (or re-index) a document from its latest version's extracted text
export function indexDocument(documentId: number) {
  const d = db();
  const latest = d
    .prepare(
      `SELECT t.text FROM document_versions v JOIN file_text t ON t.hash = v.hash
       WHERE v.document_id = ? ORDER BY v.version DESC LIMIT 1`,
    )
    .get(documentId) as { text: string } | undefined;
  d.prepare('DELETE FROM documents_fts WHERE document_id = ?').run(documentId);
  if (!latest) return;
  const ps = splitParts(latest.text);
  const insert = d.prepare('INSERT INTO documents_fts (document_id, part, parts, text) VALUES (?, ?, ?, ?)');
  ps.forEach((text, i) => insert.run(documentId, i + 1, ps.length, text));
}

// Index every document that is not indexed yet (documents added before this existed)
export function indexMissingDocuments() {
  const d = db();
  const ids = d
    .prepare('SELECT id FROM documents WHERE id NOT IN (SELECT DISTINCT document_id FROM documents_fts)')
    .all() as { id: number }[];
  for (const { id } of ids) indexDocument(id);
}

export type DocInfo = {
  id: number;
  displayName: string;
  folderLabel: string | null;
  relPath: string | null;
  version: number;
  hash: string;
  storedPath: string;
  personal: boolean;
  owner: string | null;
};

export function documentInfo(id: number): DocInfo | null {
  const r = db()
    .prepare(
      `SELECT d.id, d.display_name, d.folder_label, d.rel_path, d.personal, d.owner, v.version, v.hash, v.stored_path
       FROM documents d JOIN document_versions v ON v.document_id = d.id
       WHERE d.id = ? ORDER BY v.version DESC LIMIT 1`,
    )
    .get(id) as any;
  if (!r) return null;
  return {
    id: r.id,
    displayName: r.display_name,
    folderLabel: r.folder_label,
    relPath: r.rel_path,
    version: r.version,
    hash: r.hash,
    storedPath: r.stored_path,
    personal: !!r.personal,
    owner: r.owner,
  };
}

// Documents a person may see: everything shared, plus their own personal ones
const VISIBLE = '(d.personal = 0 OR d.owner = ?)';

export function findDocumentByName(name: string, user: string): number | null {
  const r = db()
    .prepare(`SELECT id FROM documents d WHERE (lower(display_name) = lower(?) OR lower(rel_path) = lower(?)) AND ${VISIBLE} ORDER BY id DESC LIMIT 1`)
    .get(name.trim(), name.trim(), user) as { id: number } | undefined;
  return r?.id ?? null;
}

export function searchDocuments(q: string, user: string, limit = 6) {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean);
  if (!terms.length) return [];
  // Any of the words, best matches first
  const query = terms.map((t) => `"${t}"*`).join(' OR ');
  try {
    return db()
      .prepare(
        `SELECT f.document_id AS id, f.part, f.parts, d.display_name AS name, d.folder_label AS folder, d.rel_path AS relPath,
                d.personal AS personal, snippet(documents_fts, 3, '[', ']', '...', 24) AS snippet
         FROM documents_fts f JOIN documents d ON d.id = f.document_id
         WHERE documents_fts MATCH ? AND ${VISIBLE} ORDER BY rank LIMIT ?`,
      )
      .all(query, user, limit) as {
      id: number;
      part: number;
      parts: number;
      name: string;
      folder: string | null;
      relPath: string | null;
      personal: number;
      snippet: string;
    }[];
  } catch {
    return [];
  }
}

export function readDocumentPart(id: number, part: number): { text: string; part: number; parts: number } | null {
  const r = db()
    .prepare('SELECT text, part, parts FROM documents_fts WHERE document_id = ? AND part = ?')
    .get(id, Math.max(1, Math.floor(part))) as { text: string; part: number; parts: number } | undefined;
  return r ?? null;
}
