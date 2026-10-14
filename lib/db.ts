import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.WIKI_DATA_DIR || './data');
export const WIKI_DIR = path.join(DATA_DIR, 'wiki');
export const ASSETS_DIR = path.join(DATA_DIR, 'assets');

const g = globalThis as unknown as { __wikiDb?: Database.Database };

export function db(): Database.Database {
  if (g.__wikiDb) return g.__wikiDb;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const d = new Database(path.join(DATA_DIR, 'wiki.db'));
  d.pragma('journal_mode = WAL');
  d.exec(`
    -- Every piece of information that enters the wiki traces back to a source row.
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,              -- chat | file | manual
      user TEXT NOT NULL,              -- who contributed it
      folder_label TEXT,               -- e.g. "Jesse / SharePoint Systems"
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
      is_new INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending | resolved
      created_at TEXT NOT NULL,
      UNIQUE (change_set_id, page_path)
    );
    CREATE INDEX IF NOT EXISTS idx_proposals_page ON proposals(page_path, status);
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL REFERENCES proposals(id),
      action TEXT NOT NULL,            -- approve | reject
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
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(path UNINDEXED, title, body);
  `);
  g.__wikiDb = d;
  return d;
}
