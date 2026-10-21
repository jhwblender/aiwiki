import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db, ASSETS_DIR, DATA_DIR } from './db';

// Files people drop into the chat or onto a page. Originals are kept under data/assets/, stored
// once per content hash, and their extracted text is cached by hash so a repeat drop is instant.

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 10;
// How much extracted text from one file the assistant reads; longer files are cut and marked
const MAX_TEXT_CHARS = 40_000;
// Scanned PDFs are read page by page with the vision model, up to this many pages
const MAX_SCAN_PAGES = 8;

export type FileKind = 'pdf' | 'docx' | 'text' | 'image';

export type StoredFile = {
  id: number;
  hash: string;
  filename: string;
  mime: string;
  size: number;
  kind: FileKind;
  storedPath: string; // relative to the data directory, never a full local path
};

export type DescribeImage = (image: { data: Buffer; mime: string }, prompt: string) => Promise<string>;

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'yaml', 'yml']);

function startsWith(buf: Buffer, bytes: number[]) {
  return bytes.every((b, i) => buf[i] === b);
}

// Decide what a file is from its first bytes and its name; refuse anything else.
function classify(filename: string, data: Buffer): { kind: FileKind; mime: string } {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (startsWith(data, [0x25, 0x50, 0x44, 0x46])) return { kind: 'pdf', mime: 'application/pdf' };
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47])) return { kind: 'image', mime: 'image/png' };
  if (startsWith(data, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg' };
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return { kind: 'image', mime: 'image/gif' };
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { kind: 'image', mime: 'image/webp' };
  }
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04]) && ext === 'docx') {
    return { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  if (TEXT_EXT.has(ext) && !data.subarray(0, 4096).includes(0)) return { kind: 'text', mime: 'text/plain; charset=utf-8' };
  if (IMAGE_MIME[ext]) throw new Error(`${filename} does not look like a valid image.`);
  throw new Error(`${filename}: this kind of file is not supported yet. Use PDF, Word (.docx), text, or a photo (PNG, JPEG, GIF, WebP).`);
}

function safeName(filename: string): string {
  const base = path.basename(filename).replace(/[^\w.\- ]+/g, '_').trim().slice(0, 120);
  return base || 'file';
}

export async function saveUpload(filename: string, data: Buffer, user: string): Promise<StoredFile> {
  if (!data.length) throw new Error(`${filename} is empty.`);
  if (data.length > MAX_FILE_BYTES) throw new Error(`${filename} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const { kind, mime } = classify(filename, data);
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  const name = safeName(filename);
  const rel = path.join('assets', hash.slice(0, 2), hash, name);
  const abs = path.join(DATA_DIR, rel);
  if (!abs.startsWith(ASSETS_DIR)) throw new Error('Invalid file name.');
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fs.access(abs);
  } catch {
    await fs.writeFile(abs, data);
  }
  const r = db()
    .prepare(
      'INSERT INTO files (hash, filename, mime, size, kind, stored_path, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(hash, name, mime, data.length, kind, rel, user, new Date().toISOString());
  return { id: Number(r.lastInsertRowid), hash, filename: name, mime, size: data.length, kind, storedPath: rel };
}

export function getFile(id: number): StoredFile | null {
  const r = db().prepare('SELECT * FROM files WHERE id = ?').get(id) as any;
  if (!r) return null;
  return { id: r.id, hash: r.hash, filename: r.filename, mime: r.mime, size: r.size, kind: r.kind, storedPath: r.stored_path };
}

export async function readStored(f: { storedPath: string }): Promise<Buffer> {
  const abs = path.join(DATA_DIR, f.storedPath);
  if (!abs.startsWith(ASSETS_DIR)) throw new Error('Invalid file path.');
  return fs.readFile(abs);
}

// ---------- extraction ----------

const PHOTO_PROMPT =
  'Describe this image for a company wiki. First transcribe any visible text exactly (labels, screens, signs, serial numbers). ' +
  'Then describe what it shows: equipment, layout, diagrams, people only by role. Be factual and do not guess beyond what is visible.';

const SCAN_PROMPT = (page: number, of: number) =>
  `This is page ${page} of ${of} of a scanned document. Transcribe all of its text exactly, keeping headings, lists and tables. ` +
  'If part of the page is a picture or diagram, describe it briefly in square brackets.';

async function pdfText(data: Buffer): Promise<{ pages: string[] }> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: false });
  return { pages: (Array.isArray(text) ? text : [text]).map((t) => t.trim()) };
}

async function renderPdfPage(data: Buffer, page: number): Promise<Buffer> {
  const { renderPageAsImage } = await import('unpdf');
  const png = await renderPageAsImage(new Uint8Array(data), page, { canvasImport: () => import('@napi-rs/canvas'), scale: 1.6 });
  return Buffer.from(png);
}

async function extractFresh(f: StoredFile, data: Buffer, describe: DescribeImage | null): Promise<{ text: string; method: string }> {
  if (f.kind === 'text') return { text: data.toString('utf8'), method: 'text' };
  if (f.kind === 'docx') {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: data });
    return { text: value.replace(/\n{3,}/g, '\n\n').trim(), method: 'docx' };
  }
  if (f.kind === 'image') {
    if (!describe) throw new Error('No model is set up to read photos.');
    return { text: await describe({ data, mime: f.mime }, PHOTO_PROMPT), method: 'vision' };
  }
  // PDF: use its text layer; a page with almost no text is probably a scan
  const { pages } = await pdfText(data);
  const textChars = pages.reduce((n, p) => n + p.length, 0);
  if (textChars >= 40 * pages.length) {
    return { text: pages.map((p, i) => `--- Page ${i + 1} ---\n${p}`).join('\n\n'), method: 'pdf-text' };
  }
  if (!describe) throw new Error('This PDF looks like a scan, and no model is set up to read images.');
  const count = Math.min(pages.length, MAX_SCAN_PAGES);
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    out.push(`--- Page ${i} (scanned) ---\n${await describe({ data: await renderPdfPage(data, i), mime: 'image/png' }, SCAN_PROMPT(i, pages.length))}`);
  }
  if (pages.length > count) out.push(`(Only the first ${count} of ${pages.length} scanned pages were read.)`);
  return { text: out.join('\n\n'), method: 'pdf-scan' };
}

// Text the assistant reads for a file, cached by content hash.
export async function extractText(f: StoredFile, describe: DescribeImage | null): Promise<{ text: string; method: string; truncated: boolean }> {
  const cached = db().prepare('SELECT text, method FROM file_text WHERE hash = ?').get(f.hash) as { text: string; method: string } | undefined;
  const full = cached ?? (await extractFresh(f, await readStored(f), describe));
  if (!cached) {
    db().prepare('INSERT OR REPLACE INTO file_text (hash, text, method, created_at) VALUES (?, ?, ?, ?)').run(f.hash, full.text, full.method, new Date().toISOString());
  }
  const truncated = full.text.length > MAX_TEXT_CHARS;
  return { text: truncated ? full.text.slice(0, MAX_TEXT_CHARS) : full.text, method: full.method, truncated };
}

// How many earlier versions of a file with this name this person has dropped
export function fileVersion(filename: string, hash: string, user: string): number {
  const rows = db()
    .prepare("SELECT DISTINCT content_hash FROM sources WHERE kind = 'file' AND filename = ? AND user = ? AND content_hash != ?")
    .all(filename, user, hash) as unknown[];
  return rows.length + 1;
}
