# CLAUDE.md

AI-integrated company wiki. People use it like a normal wiki. A built-in assistant can search and read the wiki to answer questions, and it turns new information (chat messages, and later dropped or watched files) into proposed edits that anyone can approve or reject inline on the page.

Audience: starts with the systems team, eventually the whole company. Most reviewers are not programmers.

## Commands

- `npm run dev` starts the app on http://localhost:3000
- `npm run build` type checks and builds; run it before calling any change done
- Config lives in `.env.local` (see `.env.example`); data lives in `./data` (`WIKI_DATA_DIR`)
- Delete `./data` to reset to the seed wiki

## Architecture

- **Next.js 15 (App Router, TypeScript)**: one app serving the UI and the REST API
- **`lib/wiki.ts`**: pages are markdown files in `data/wiki/`, which is a git repo. All git calls go through `serial()` so concurrent writes never collide. Search is SQLite FTS5, rebuilt from the files on startup
- **`lib/diff.ts`**: paragraph-level diff (blocks split on blank lines). A hunk is one run of removed and added blocks and is the unit a reviewer approves. Each hunk has a fingerprint so stale approvals are rejected
- **`lib/proposals.ts`**: sources, change sets, proposals, decisions and page_sources (schema in `lib/db.ts`)
- **`lib/ai/`**: `providers.ts` (Anthropic SDK plus one OpenAI-compatible adapter for Ollama, LM Studio and vLLM), `tools.ts` (wiki tools), `agent.ts` (tool loop, max 10 steps)
- **`components/`**: `Shell`, `Sidebar`, `PageView` (inline review), `ChatPanel`, `SourceChip`, `Md` (markdown plus `[[wiki links]]`)

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

There is no test suite yet. The flow was verified with a scripted OpenAI-compatible mock server: point `LOCAL_LLM_BASE_URL` at a small Node HTTP server that returns canned `tool_calls`, then drive `/api/chat`, `/api/page` and `/api/proposals/:id/hunk|resolve` with curl. Recreate that as a proper script (for example `scripts/e2e.mjs`) early, and run it after any change to proposals or the agent.

## Known gaps (do these first)

1. **The UI has never been viewed in a browser.** Run the app, look at every screen at desktop and phone width, and fix layout and styling problems.
2. **The Anthropic adapter has not run against the real API.** Run a full propose and approve cycle with a real key and fix any message-format issues.
3. Names typed in the sidebar are not authenticated; treat them as labels only.

## Roadmap, in order

1. **File and photo drop** into the chat panel and onto pages. Store originals under `data/assets/`, extract text (PDF, docx; vision fallback for scans), describe photos with vision, create a `file` source, and let the agent propose edits as one change set. Link the original from the source chip
2. **Ingest queue** shared by all file sources: dedupe by content hash; diff a changed file against its previous version so content is not duplicated
3. **Local folder watcher** on the server, feeding the same queue
4. **Companion desktop app**: watches folders on a user's machine (SharePoint libraries via the OneDrive sync client, with Files On-Demand off for that folder), uploads to the queue with the user's identity, and relays calls to a local model so a remote wiki can use AI on the user's own computer
5. **Per-folder visibility**: "feeds wiki" or "personal only". Personal-only content is searchable by that user's chat but never proposed as a wiki edit
6. **Conflict handling**: when sources disagree, the proposal cites both and flags the conflict instead of silently picking one
7. **Bulk review** for large drops: a per-source summary and one approval for a whole change set across pages
8. **Real auth and roles** (likely Entra ID SSO), including who can approve
