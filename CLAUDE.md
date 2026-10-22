# CLAUDE.md

AI-integrated company wiki. People use it like a normal wiki. A built-in assistant can search and read the wiki to answer questions, and it turns new information (chat messages, and later dropped or watched files) into proposed edits that anyone can approve or reject inline on the page.

Audience: starts with the systems team, eventually the whole company. Most reviewers are not programmers.

## Commands

- `./start.sh` is the one-command start for people running the wiki: installs packages when needed, creates `.env.local`, rebuilds into `.next-prod` only when code changed, and starts the optimised server (`--dev`, `--open`, `--shortcut` for a Windows desktop launcher)
- `./stop.sh` stops the wiki on `PORT` (default 3000), only if a Next.js server is what listens there
- `npm run dev` starts the development server on http://localhost:3000
- `npm run build` type checks and builds; run it before calling any change done (while `npm run dev` is running, use `NEXT_DIST_DIR=.next-e2e npx next build` so the two do not share `.next`)
- `npm run e2e` runs the end-to-end check (needs nothing running; uses ports 3100 and 4556)
- `npm run mock-llm` starts the scripted mock model on port 4555; set `LOCAL_LLM_BASE_URL=http://127.0.0.1:4555/v1` to click through the UI without a real model
- Config lives in `.env.local` (see `.env.example`); data lives in `./data` (`WIKI_DATA_DIR`)
- Delete `./data` to reset to the seed wiki

## Architecture

- **Next.js 15 (App Router, TypeScript)**: one app serving the UI and the REST API
- **`lib/wiki.ts`**: pages are markdown files in `data/wiki/`, which is a git repo. All git calls go through `serial()` so concurrent writes never collide. Search is SQLite FTS5, rebuilt from the files on startup
- **`lib/diff.ts`**: paragraph-level diff (blocks split on blank lines). A hunk is one run of removed and added blocks and is the unit a reviewer approves. Each hunk has a fingerprint so stale approvals are rejected. `rebase` replays a suggestion onto a page that changed since it was written; overlapping paragraphs make it a conflict that can only be rejected
- **`lib/proposals.ts`**: sources, change sets, proposals, decisions and page_sources (schema in `lib/db.ts`)
- **`lib/ai/`**: `providers.ts` (registry and Anthropic adapter), `local.ts` (OpenAI-compatible adapter for Ollama, LM Studio and vLLM, plus the Settings connection test), `tools.ts` (wiki tools), `agent.ts` (tool loop, max 10 steps)
- **Pending awareness**: `read_page` shows the approved page plus a separately labelled list of other people's pending suggestions. Each chat sends a `chatId`; a later message in the same chat (same name) edits on top of that chat's pending suggestion and supersedes it (`proposals.superseded_by`), and approval records every message in the chain as a source
- **Page structure**: paths nest up to 5 levels; every page lists its sub-pages and sidebar folders open their section. `movePage` in `lib/wiki.ts` moves a page with everything under it and rewrites `[[links]]` and `/wiki/` links on every page in one commit; `movePageWithRecords` in `lib/proposals.ts` carries pending suggestions, sources and structural suggestions along
- **Structural suggestions**: the assistant's `move_page` and `remove_page` tools stage rows in `page_ops`, shown as a card on the page with Approve and Reject (`/api/ops/:id`, decisions in `op_decisions`). Splits and merges combine these with the normal edit tools
- **Files (`lib/files.ts`)**: uploads go to `/api/files`, are classified by their first bytes (PDF, docx, text, PNG, JPEG, GIF, WebP; 25 MB, 10 per message) and stored once per SHA-256 under `data/assets/`. Extracted text is cached in `file_text` by hash: PDF text layer via unpdf, scanned pages rendered with @napi-rs/canvas and read by the vision model, Word via mammoth, photos described by `provider.describeImage`. The agent reads attachments before its loop and passes them inside `<<<Attached file>>>` markers as information, not instructions. Each file becomes a `file` source (filename, hash, version, stored path); extra files in one message link through `change_set_sources`. Originals open from the source chip (`/api/sources/:id/file`); photos can be shown on pages with `/api/files/:id`
- **Documents and versions (`lib/ingest.ts`)**: every file belongs to a document (`drop:<name>` for drops, later `folder:<label>:<path>`), and each distinct content is a version. `checkVersion` decides new, unchanged or changed without writing; `recordVersion` writes only after the assistant finished, so failures can be retried. An unchanged file is pointed out (and skipped in the queue); a changed one is reduced to the paragraphs that changed
- **Ingest queue (`lib/queue.ts`)**: `ingest_jobs` processed one at a time by an in-process worker, resumed at startup by `instrumentation.ts` (Node-only code lives in `instrumentation-node.ts`). Jobs run the same agent as the chat, with the model picked in the chat. Chat offers "File in the background". Settings shows counts per status (filterable), the running job with a live log of its steps and Stop, Pause and Resume (stored as `queue.paused` in `settings`; the running file finishes first), Cancel per job or all waiting (optionally per folder), and Try again per job or for all failed. The queue reads each file itself before running the assistant, so unreadable files fail and can be retried; when the model cannot be reached the job goes back and the queue waits 30 s doubling to 10 min (`INGEST_RETRY_SECONDS`), with Try now
- **Watched folders (`lib/watcher.ts`)**: folders on the server, added on Settings (Windows paths are translated for WSL). Every `WATCH_INTERVAL_SECONDS` (default 60) each enabled folder is walked; files whose size or time changed are hashed, and new content is stored and queued as document `folder:<label>:<relative path>`. Files changed in the last 10 seconds wait for the next scan; hidden and Office lock files are skipped. The folder is never written to
- **Document lookup (`lib/docsearch.ts`)**: the latest version of every document is indexed in ~1500 character parts in `documents_fts` when a version is recorded (and at startup for any not yet indexed). The `search_documents` and `read_document` tools let the assistant answer from originals; it must say such answers are not in the wiki yet. A document read during a run becomes a source of anything suggested in that run
- **Live updates**: chat requests run on the server (`lib/runs.ts`), so closing the chat does not stop them; the chat reconnects via `/api/chat/runs/:id`. `lib/pulse.ts` counts changes and open pages poll `/api/pulse` to refresh
- **`lib/settings.ts`**: Settings page values (local model address, model, key) stored in SQLite, overriding `.env.local`
- **`components/`**: `Shell` (mounted once from `app/wiki/layout.tsx` so chat survives navigation), `Sidebar`, `PageView` (inline review), `wordMarks` (changed-word highlights), `ChatPanel`, `SourceChip`, `Md` (markdown plus `[[wiki links]]`)

## Rules that must not break

1. **Markdown in git is the source of truth.** SQLite holds search, proposals and provenance; never live page content.
2. **The AI never writes to the wiki.** Its tools only stage proposals. Only a human approval calls `writePage`. Any new AI capability (file ingest, folder watching) must go through `createSource`, then `createChangeSet`, then `stageContent`.
3. **Approval happens inline on the page.** No separate review screen, queue page or diff viewer. The sidebar badge is the only pointer to pending work.
4. **Never expose git concepts in the UI.** No branches, commits, hashes or "diff" wording. Reviewers see highlighted changes and Approve or Reject.
5. **Every proposal links to a source record**: who contributed it, the watched folder label and relative path (never a full local path), filename, content hash, version and time. Approvals copy the source into `page_sources` and into the git commit message.
6. **Stay provider-neutral.** The agent loop and tools must work with both providers. Do not use Anthropic-only features in the shared path.
7. **Human edits publish immediately** and are committed under the editor's name.

## Conventions

- Never use an em dash anywhere: UI copy, docs, code comments, commit messages. Use a semicolon or rework the sentence
- UI copy: plain sentence case, active verbs, buttons name the action ("Approve all", "Save page")
- Keep the visual style: IBM Plex Sans for UI, Source Serif 4 for page content, teal accent, green additions, red struck-through removals
- Layout must work at phone width
- Small, focused commits; one feature per commit

## Testing

`npm run e2e` (`scripts/e2e.mjs`) starts `scripts/mock-llm.mjs` and a dev server on a throwaway data directory, then drives `/api/chat`, `/api/page` and `/api/proposals/:id/hunk|resolve`. The mock answers both the OpenAI-compatible and the Anthropic Messages formats from keyword-picked scenarios, and rejects Anthropic tool loops that drop thinking blocks or split tool results. Run it after any change to proposals, the diff, or the agent; add a scenario to the mock when you add a flow.

## Known gaps (do these first)

1. **The Anthropic adapter has not run against the real API.** Its message format is checked against the mock, but run a full propose and approve cycle with a real key (also confirms the `server-side-fallback-2026-07-01` fallback option is accepted for the account).
2. Local models: a full cycle works with qwen3.6 35b on Ollama (Windows host, wiki in WSL with mirrored networking). Near-miss tool and argument names are mapped by `normalizeCall` in `lib/ai/tools.ts`; extend its aliases when a model shows a new variant. Keep Ollama's context length at 16k or more so long pages are not cut off.
3. **Photos and scans have only been tested with the mock.** Run the Settings connection test against a real vision model (for example qwen2.5vl on Ollama) and drop a real photo and a scanned PDF. Text PDFs and Word files do not need a vision model.
4. Names set on the Settings page are not authenticated; treat them as labels only. Settings (model address, watched folders) is open to anyone who can reach the wiki; until real auth lands, run the wiki only where everyone who can reach it is trusted.
5. A file deleted from a watched folder is ignored; nothing suggests removing what it added. Decide whether a deletion should suggest edits before watching shared libraries at scale.
6. Node 18 works in every test so far, but `better-sqlite3` 12 declares Node 20+ and `unpdf` declares Node 22+; use Node 22 or newer.

## Roadmap, in order

1. **Use the folder structure when filing.** Today the assistant only sees a file's name. For files from watched folders, give it the folder label, the path inside the folder (for example `Drone Docs/Maintenance/Loctite Selection.webp`) and a compact outline of the whole watched folder (sub-folder names and file counts), and ask it to use that structure as a guide (not a one to one copy) where it fits: matching sections, sub-pages that follow the folders, and related files placed together. Chat drops have no path, so they keep today's behaviour. Small change in `lib/ingest.ts` (`prepareFile`) and `lib/queue.ts`; the outline can be built from `watched_files`
2. **Per-folder visibility**: "feeds wiki" or "personal only". Personal-only content is searchable by that user's chat but never proposed as a wiki edit
3. **Librarian.** A background pass that keeps the wiki organised beyond single edits: finds duplicate or overlapping pages, pages in the wrong section, sections without an overview, and stale cross-links, and suggests moves, merges and overview pages through the normal suggestion tools. Start on demand (a Tidy button per section on Settings, or asking in chat), scoped to one section per run with a cap on suggestions, and only later run it on a schedule or after a large batch of filing. Everything stays a suggestion reviewed on the page. It should use the watched folder structure and folder paths as hints, not a template to copy one to one, and be especially good at fixing up what filing left untidy: misplaced pages, duplicates across folders and missing overview pages
4. **Conflict handling**: when sources disagree, the proposal cites both and flags the conflict instead of silently picking one
5. **Bulk review** for large drops: a per-source summary and one approval for a whole change set across pages
6. **Companion desktop app** (only needed when the wiki server cannot reach the model; a model on the server itself or on a machine it can reach on the network already works through `LOCAL_LLM_BASE_URL`): watches folders on a user's machine (SharePoint libraries via the OneDrive sync client, with Files On-Demand off for that folder), uploads to the queue with the user's identity, and relays calls to a local model so a remote wiki can use AI on the user's own computer
7. **Real auth and roles** (likely Entra ID SSO), including who can approve and who can change Settings and watched folders
