# CLAUDE.md

AI-integrated company wiki. People use it like a normal wiki. A built-in assistant can search and read the wiki to answer questions, and it turns new information (chat messages, and later dropped or watched files) into proposed edits that anyone can approve or reject inline on the page.

Audience: starts with the systems team, eventually the whole company. Most reviewers are not programmers.

## Commands

- `npm run dev` starts the app on http://localhost:3000
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
- **`lib/ai/`**: `providers.ts` (Anthropic SDK plus one OpenAI-compatible adapter for Ollama, LM Studio and vLLM), `tools.ts` (wiki tools), `agent.ts` (tool loop, max 10 steps)
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
2. **The local adapter has not run against a real local model.** Only the mock has been used. Run a full cycle with Ollama or LM Studio and a tool-calling model (for example qwen2.5 14b). Ollama's default context window is small and silently truncates long prompts, so raise it (`OLLAMA_CONTEXT_LENGTH`, or `num_ctx` in a Modelfile, to 16k or more). Smaller models may send tool arguments under slightly wrong names or as broken JSON; make `runTool` tolerant and return clear errors the model can correct from.
3. Names typed in the sidebar are not authenticated; treat them as labels only.
4. Node 18 works but `better-sqlite3` 12 declares Node 20+; use Node 20 or newer.

## Roadmap, in order

1. **Pending-aware assistant.** Today `read_page` and `search_pages` see only approved content, plus edits staged earlier in the same agent run, so the assistant cannot see pending suggestions and each chat message starts a fresh change set. Show pending suggestions to the assistant in `read_page` as a separate, labelled section (never mixed into the approved text, and never treated as fact in answers), and let a follow-up message in the same chat revise that chat's own pending suggestion instead of creating a competing one. Do this before file drops, which will multiply pending suggestions
2. **File and photo drop** into the chat panel and onto pages. Store originals under `data/assets/`, extract text (PDF, docx; vision fallback for scans), describe photos with vision, create a `file` source, and let the agent propose edits as one change set. Link the original from the source chip
3. **Ingest queue** shared by all file sources: dedupe by content hash; diff a changed file against its previous version so content is not duplicated
4. **Local folder watcher** on the server, feeding the same queue
5. **Companion desktop app** (only needed when the wiki server cannot reach the model; a model on the server itself or on a machine it can reach on the network already works through `LOCAL_LLM_BASE_URL`): watches folders on a user's machine (SharePoint libraries via the OneDrive sync client, with Files On-Demand off for that folder), uploads to the queue with the user's identity, and relays calls to a local model so a remote wiki can use AI on the user's own computer
6. **Per-folder visibility**: "feeds wiki" or "personal only". Personal-only content is searchable by that user's chat but never proposed as a wiki edit
7. **Conflict handling**: when sources disagree, the proposal cites both and flags the conflict instead of silently picking one
8. **Bulk review** for large drops: a per-source summary and one approval for a whole change set across pages
9. **Real auth and roles** (likely Entra ID SSO), including who can approve
