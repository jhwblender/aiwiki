import { diffArrays } from 'diff';
import { db } from './db';
import { toBlocks } from './diff';
import { indexDocument, splitParts } from './docsearch';
import { extractText, type DescribeImage, type StoredFile } from './files';

// Every file that reaches the wiki (chat drops now, watched folders next) goes through here.
// A document is identified by where it came from, and each distinct content is a version.
// Re-sending the same content is recognised, and a changed document is reduced to what changed,
// so the assistant updates the wiki instead of adding the same facts again.

export type DocIdentity = {
  key: string; // stable identity, e.g. "drop:parts list.docx" or "folder:<label>:<relative path>"
  displayName: string;
  folderLabel?: string | null;
  relPath?: string | null;
  // From a personal-only folder: searchable by the owner's chat, never filed into the wiki
  personal?: boolean;
  owner?: string | null;
};

export function dropIdentity(filename: string): DocIdentity {
  return { key: `drop:${filename.toLowerCase()}`, displayName: filename };
}

export type VersionInfo = {
  version: number;
  status: 'new' | 'unchanged' | 'changed';
  previous?: { version: number; hash: string; at: string };
  // The same content already arrived under another name
  duplicateOf?: { displayName: string; at: string };
};

const now = () => new Date().toISOString();

// What a file would be for its document, without recording anything. A version is only
// recorded once the assistant has handled it, so a failed attempt can be tried again.
export function checkVersion(id: DocIdentity, f: StoredFile): VersionInfo {
  const d = db();
  const doc = d.prepare('SELECT id FROM documents WHERE doc_key = ?').get(id.key) as { id: number } | undefined;
  const latest = doc
    ? (d
        .prepare('SELECT version, hash, added_at FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1')
        .get(doc.id) as { version: number; hash: string; added_at: string } | undefined)
    : undefined;
  if (latest && latest.hash === f.hash) {
    return { version: latest.version, status: 'unchanged', previous: { version: latest.version, hash: latest.hash, at: latest.added_at } };
  }
  const dup = d
    .prepare(
      `SELECT doc.display_name, v.added_at FROM document_versions v JOIN documents doc ON doc.id = v.document_id
       WHERE v.hash = ? AND doc.doc_key != ? AND doc.personal = 0 ORDER BY v.added_at LIMIT 1`,
    )
    .get(f.hash, id.key) as { display_name: string; added_at: string } | undefined;
  return {
    version: (latest?.version ?? 0) + 1,
    status: latest ? 'changed' : 'new',
    previous: latest ? { version: latest.version, hash: latest.hash, at: latest.added_at } : undefined,
    duplicateOf: dup ? { displayName: dup.display_name, at: dup.added_at } : undefined,
  };
}

export function recordVersion(id: DocIdentity, f: StoredFile, user: string, info: VersionInfo) {
  if (info.status === 'unchanged') return;
  const d = db();
  d.transaction(() => {
    let doc = d.prepare('SELECT id FROM documents WHERE doc_key = ?').get(id.key) as { id: number } | undefined;
    if (!doc) {
      const r = d
        .prepare('INSERT INTO documents (doc_key, display_name, folder_label, rel_path, created_at, personal, owner) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id.key, id.displayName, id.folderLabel ?? null, id.relPath ?? null, now(), id.personal ? 1 : 0, id.owner ?? null);
      doc = { id: Number(r.lastInsertRowid) };
    } else {
      d.prepare('UPDATE documents SET personal = ?, owner = ? WHERE id = ?').run(id.personal ? 1 : 0, id.owner ?? null, doc.id);
    }
    d.prepare(
      'INSERT OR IGNORE INTO document_versions (document_id, version, hash, stored_path, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(doc.id, info.version, f.hash, f.storedPath, user, now());
    // Keep the document searchable for the assistant
    indexDocument(doc.id);
  })();
}

// Paragraph-level changes between two versions of a document's text
export function textChanges(before: string, after: string): { removed: string[]; added: string[] }[] {
  const out: { removed: string[]; added: string[] }[] = [];
  let cur: { removed: string[]; added: string[] } | null = null;
  for (const part of diffArrays(toBlocks(before), toBlocks(after))) {
    if (part.added || part.removed) {
      if (!cur) out.push((cur = { removed: [], added: [] }));
      (part.added ? cur.added : cur.removed).push(...(part.value as string[]));
    } else cur = null;
  }
  return out;
}

const day = (iso: string) => iso.slice(0, 10);

// Files longer than this are handed over in parts of about this size
const LONG_FILE_CHARS = 12_000;
const PART_CHARS = 8_000;

// Search parts are small; join them into parts the assistant reads one at a time
function groupParts(small: string[]): string[] {
  const out: string[] = [];
  for (const p of small) {
    if (out.length && out[out.length - 1].length + p.length < PART_CHARS) out[out.length - 1] += `\n\n${p}`;
    else out.push(p);
  }
  return out;
}

// A part's first heading, or its first words
function partLine(part: string): string {
  const heading = part.match(/^#{1,6}\s+(.+)$/m)?.[1];
  const text = (heading ?? part).replace(/\s+/g, ' ').trim();
  return text.length > 90 ? text.slice(0, 87) + '...' : text;
}
const MAX_CHANGE_CHARS = 20_000;

// The text the assistant gets for one file, shaped by whether it is new, unchanged or changed.
export async function prepareFile(
  f: StoredFile & { id: number },
  describe: DescribeImage | null,
  info: VersionInfo,
  displayName: string,
  // Where the file sits in a watched folder (see lib/folderContext.ts); absent for chat drops
  location?: string,
): Promise<{ section: string; note: string; parts?: string[] }> {
  const out = await extractText(f, describe);
  const how =
    out.method === 'vision' ? 'photo, described by the vision model' : out.method === 'pdf-scan' ? 'scanned PDF, read page by page' : f.kind;
  const head =
    `<<<Attached file "${displayName}" (${how}, version ${info.version})>>>` +
    (location
      ? `\n${location}\nUse the folder path and outline as hints about where this belongs in the wiki: sections and sub-pages can follow ` +
        'the folders where that makes sense, and related files belong together. Do not copy the folder tree one to one.'
      : '');
  const photoHint = f.kind === 'image' ? `To show this photo on a page, use ![short description](/api/files/${f.id})\n` : '';
  const full = `${out.text}\n${out.truncated ? '(The file is longer; only the beginning is shown.)\n' : ''}`;
  const end = '<<<End of file>>>';

  if (info.status === 'unchanged') {
    return {
      note: `${displayName} is unchanged since ${day(info.previous!.at)}`,
      section:
        `${head}\nThis exact file was already added on ${day(info.previous!.at)}. Its information should already be in the wiki or waiting for review. ` +
        'Do not suggest it again unless the person asks for something specific; you may still answer questions about it.\n' +
        `${full}${photoHint}${end}`,
    };
  }

  if (info.status === 'changed' && f.kind !== 'image') {
    const prev = db().prepare('SELECT text FROM file_text WHERE hash = ?').get(info.previous!.hash) as { text: string } | undefined;
    if (prev) {
      const changes = textChanges(prev.text, out.full);
      if (!changes.length) {
        return {
          note: `${displayName} changed only in layout since version ${info.previous!.version}`,
          section: `${head}\nThis is a new copy of version ${info.previous!.version} (from ${day(info.previous!.at)}) with no changes to its text. Do not suggest anything from it again.\n${end}`,
        };
      }
      let listed = changes
        .map((c, i) => {
          const parts = [`Change ${i + 1}:`];
          if (c.removed.length) parts.push(`  No longer says:\n${c.removed.map((b) => `    ${b}`).join('\n')}`);
          if (c.added.length) parts.push(`  Now says:\n${c.added.map((b) => `    ${b}`).join('\n')}`);
          return parts.join('\n');
        })
        .join('\n');
      if (listed.length > MAX_CHANGE_CHARS) listed = listed.slice(0, MAX_CHANGE_CHARS) + '\n(More changes follow; only the first are shown.)';
      return {
        note: `${displayName} has ${changes.length} change${changes.length > 1 ? 's' : ''} since version ${info.previous!.version}`,
        section:
          `${head}\nThis is an updated version of a document first added earlier (previous version ${info.previous!.version}, ${day(info.previous!.at)}). ` +
          'Only the changes below are new. Update the wiki for these changes only: edit existing statements in place and remove what the document no longer says. ' +
          'Write the changes as wiki content about the subject itself, never as comments about a file ("this file now contains"). ' +
          'Do not add the unchanged parts again.\n' +
          `${listed}\n${end}`,
      };
    }
  }

  const dupNote = info.duplicateOf
    ? `The same content was already added as "${info.duplicateOf.displayName}" on ${day(info.duplicateOf.at)}; check the wiki before suggesting anything from it again.\n`
    : '';
  // A long document comes in parts: the first, and a line on each of the others, so the assistant
  // can stop when the beginning shows it is not worth filing, or read on only where it matters
  if (f.kind !== 'image' && out.full.length > LONG_FILE_CHARS) {
    const parts = groupParts(splitParts(out.full));
    const outline = parts.slice(1).map((p, i) => `  Part ${i + 2}: ${partLine(p)}`).join('\n');
    return {
      note: `${displayName}, part 1 of ${parts.length}`,
      parts,
      section:
        `${head}\n${dupNote}This file is long, so only part 1 of ${parts.length} is shown. The other parts begin:\n${outline}\n` +
        'If part 1 shows the file is not worth filing (raw data, logs, a copy of something already in the wiki), say so and stop. ' +
        'Otherwise read the parts that hold something worth filing with read_file_part, and skip the rest.\n' +
        `--- Part 1 ---\n${parts[0]}\n${photoHint}${end}`,
    };
  }
  return { note: '', section: `${head}\n${dupNote}${full}${photoHint}${end}` };
}
