import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.WIKI_DATA_DIR || './data');
export const WIKI_DIR = path.join(DATA_DIR, 'wiki');
export const ASSETS_DIR = path.join(DATA_DIR, 'assets');

const g = globalThis as unknown as { __wikiDb?: Database.Database };

// The connection is kept on globalThis so dev reloads reuse it, but the schema step runs once
// per module load, so tables added in a code change appear without restarting the server.
let migrated = false;

export function db(): Database.Database {
  if (g.__wikiDb && migrated) return g.__wikiDb;
  if (!g.__wikiDb) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    g.__wikiDb = new Database(path.join(DATA_DIR, 'wiki.db'));
    g.__wikiDb.pragma('journal_mode = WAL');
  }
  migrate(g.__wikiDb);
  migrated = true;
  return g.__wikiDb;
}

function migrate(d: Database.Database) {
  d.exec(`
    -- Every piece of information that enters the wiki traces back to a source row.
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,              -- chat | file | manual | librarian
      user TEXT NOT NULL,              -- who contributed it
      folder_label TEXT,               -- e.g. "Engineering SharePoint"
      rel_path TEXT,                   -- path relative to the watched folder
      filename TEXT,
      content_hash TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      stored_path TEXT,                -- original file kept under assets/
      note TEXT,                       -- e.g. the chat message that triggered the change
      detected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS change_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER REFERENCES sources(id),
      summary TEXT NOT NULL,
      created_by TEXT NOT NULL,        -- e.g. ai:anthropic
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_set_id INTEGER NOT NULL REFERENCES change_sets(id),
      page_path TEXT NOT NULL,
      new_content TEXT NOT NULL,
      base_content TEXT,               -- the live page this suggestion was written against
      is_new INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending | resolved | superseded
      created_at TEXT NOT NULL,
      UNIQUE (change_set_id, page_path)
    );
    CREATE INDEX IF NOT EXISTS idx_proposals_page ON proposals(page_path, status);
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL REFERENCES proposals(id),
      action TEXT NOT NULL,            -- approve | reject | supersede
      scope TEXT NOT NULL,             -- hunk | all
      user TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS page_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_path TEXT NOT NULL,
      source_id INTEGER NOT NULL REFERENCES sources(id),
      approved_by TEXT NOT NULL,
      approved_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_page_sources_page ON page_sources(page_path);
    -- Suggested structural changes: move a page (with its sub-pages) or remove it
    CREATE TABLE IF NOT EXISTS page_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_set_id INTEGER NOT NULL REFERENCES change_sets(id),
      kind TEXT NOT NULL,              -- move | remove
      page_path TEXT NOT NULL,
      new_path TEXT,                   -- for moves
      status TEXT NOT NULL DEFAULT 'pending',   -- pending | resolved | superseded
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_page_ops_page ON page_ops(page_path, status);
    CREATE TABLE IF NOT EXISTS op_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      op_id INTEGER NOT NULL REFERENCES page_ops(id),
      action TEXT NOT NULL,            -- approve | reject
      user TEXT NOT NULL,
      at TEXT NOT NULL
    );
    -- Files dropped into the chat or onto a page; the original is kept under assets/
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      kind TEXT NOT NULL,              -- pdf | docx | text | image
      stored_path TEXT NOT NULL,       -- relative to the data directory
      uploaded_by TEXT NOT NULL,
      uploaded_at TEXT NOT NULL
    );
    -- Extracted text per content hash, so the same file is only read once
    CREATE TABLE IF NOT EXISTS file_text (
      hash TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      method TEXT NOT NULL,            -- text | docx | pdf-text | pdf-scan | vision
      created_at TEXT NOT NULL
    );
    -- A document seen by the wiki (a dropped file name, later a file in a watched folder) and its versions
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      folder_label TEXT,
      rel_path TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS document_versions (
      document_id INTEGER NOT NULL REFERENCES documents(id),
      version INTEGER NOT NULL,
      hash TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (document_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_document_versions_hash ON document_versions(hash);
    -- Searchable text of the latest version of each document, in parts (see lib/docsearch.ts)
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(document_id UNINDEXED, part UNINDEXED, parts UNINDEXED, text);
    -- Files waiting to be filed in the background, and librarian tidy runs (see lib/queue.ts)
    CREATE TABLE IF NOT EXISTS ingest_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER REFERENCES files(id),   -- null for a tidy run
      doc_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      folder_label TEXT,
      rel_path TEXT,
      user TEXT NOT NULL,
      note TEXT,
      current_path TEXT,
      status TEXT NOT NULL,            -- queued | working | done | skipped | failed
      detail TEXT,                     -- the assistant's reply, or why it was skipped or failed
      proposed TEXT,                   -- JSON list of pages with suggestions
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status ON ingest_jobs(status, id);
    -- Folders on the server that feed the wiki (see lib/watcher.ts) and the files seen in them
    CREATE TABLE IF NOT EXISTS watched_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL,              -- server path; shown on Settings only, never in sources
      user TEXT NOT NULL,              -- recorded as the contributor of its files
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_scan_at TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS watched_files (
      folder_id INTEGER NOT NULL REFERENCES watched_folders(id),
      rel_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      hash TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (folder_id, rel_path)
    );
    -- Files in watched folders the wiki cannot read (models, raw data, code), recorded by name and
    -- size only so the folder tree and filing plans see the whole folder; never read or queued
    CREATE TABLE IF NOT EXISTS folder_other_files (
      folder_id INTEGER NOT NULL REFERENCES watched_folders(id),
      rel_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      PRIMARY KEY (folder_id, rel_path)
    );
    -- How each folder inside a watched folder is filed (see lib/filingPlan.ts); a file follows its nearest folder's rule
    CREATE TABLE IF NOT EXISTS folder_rules (
      folder_id INTEGER NOT NULL REFERENCES watched_folders(id),
      dir TEXT NOT NULL,               -- relative folder path, "." for the top
      rule TEXT NOT NULL,              -- file | sample | index | skip
      reason TEXT,
      set_by TEXT NOT NULL,            -- pattern | librarian | a person's name
      set_at TEXT NOT NULL,
      PRIMARY KEY (folder_id, dir)
    );
    -- Extra sources of a change set, when one message brought several files
    CREATE TABLE IF NOT EXISTS change_set_sources (
      change_set_id INTEGER NOT NULL REFERENCES change_sets(id),
      source_id INTEGER NOT NULL REFERENCES sources(id),
      PRIMARY KEY (change_set_id, source_id)
    );
    -- Admin settings edited on the Settings page; values here override .env.local
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(path UNINDEXED, title, body);
  `);
  const cols = d.prepare('PRAGMA table_info(proposals)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'base_content')) d.exec('ALTER TABLE proposals ADD COLUMN base_content TEXT');
  // A later chat message can revise an earlier suggestion: the old proposal points at its replacement
  if (!cols.some((c) => c.name === 'superseded_by')) d.exec('ALTER TABLE proposals ADD COLUMN superseded_by INTEGER');
  const csCols = d.prepare('PRAGMA table_info(change_sets)').all() as { name: string }[];
  if (!csCols.some((c) => c.name === 'chat_id')) d.exec('ALTER TABLE change_sets ADD COLUMN chat_id TEXT');
  const jobCols = d.prepare('PRAGMA table_info(ingest_jobs)').all() as { name: string }[];
  if (!jobCols.some((c) => c.name === 'provider')) d.exec('ALTER TABLE ingest_jobs ADD COLUMN provider TEXT');
  // file: run the assistant and suggest edits; index: only make it searchable (personal folders)
  if (!jobCols.some((c) => c.name === 'mode')) d.exec("ALTER TABLE ingest_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'file'");
  // tidy: a librarian run over the section in doc_key ("tidy:<section>"), with at most this many suggestions
  if (!jobCols.some((c) => c.name === 'tidy_limit')) d.exec('ALTER TABLE ingest_jobs ADD COLUMN tidy_limit INTEGER');
  // Tidy runs have no file; older databases declared file_id NOT NULL, which SQLite can only drop by rebuilding the table
  if ((jobCols as { name: string; notnull?: number }[]).find((c) => c.name === 'file_id')?.notnull) {
    d.transaction(() => {
      const cols = (d.prepare('PRAGMA table_info(ingest_jobs)').all() as { name: string }[]).map((c) => c.name).join(', ');
      d.exec(`
        CREATE TABLE ingest_jobs_rebuilt (
          id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER REFERENCES files(id), doc_key TEXT NOT NULL, display_name TEXT NOT NULL,
          folder_label TEXT, rel_path TEXT, user TEXT NOT NULL, note TEXT, current_path TEXT, status TEXT NOT NULL, detail TEXT, proposed TEXT,
          created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, provider TEXT, mode TEXT NOT NULL DEFAULT 'file', tidy_limit INTEGER
        );
        INSERT INTO ingest_jobs_rebuilt (${cols}) SELECT ${cols} FROM ingest_jobs;
        DROP TABLE ingest_jobs;
        ALTER TABLE ingest_jobs_rebuilt RENAME TO ingest_jobs;
        CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status ON ingest_jobs(status, id);
      `);
    })();
  }
  // Personal documents are searchable only by their owner and never become wiki edits
  const docCols = d.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
  if (!docCols.some((c) => c.name === 'personal')) d.exec('ALTER TABLE documents ADD COLUMN personal INTEGER NOT NULL DEFAULT 0');
  if (!docCols.some((c) => c.name === 'owner')) d.exec('ALTER TABLE documents ADD COLUMN owner TEXT');
  d.exec('CREATE INDEX IF NOT EXISTS idx_ingest_jobs_doc ON ingest_jobs(doc_key, id)');
  const folderCols = d.prepare('PRAGMA table_info(watched_folders)').all() as { name: string }[];
  if (!folderCols.some((c) => c.name === 'visibility')) d.exec("ALTER TABLE watched_folders ADD COLUMN visibility TEXT NOT NULL DEFAULT 'wiki'");
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      name TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'viewer',
      passcode_hash TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_name TEXT NOT NULL REFERENCES users(name),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_name);
  `);
}
