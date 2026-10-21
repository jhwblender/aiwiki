# AI Wiki prototype

A team wiki with a built-in assistant. People edit pages like any wiki. The assistant can search and read the wiki to answer questions, and when someone tells it new information it proposes edits that appear highlighted on the page for anyone to approve or reject in place.

## Run it

```
./start.sh
```

That one command installs what is needed the first time, creates `.env.local`, builds the wiki when the code has changed, and starts it on http://localhost:3000. Open the Settings page to connect a model.

- `./start.sh --open` also opens your browser when the wiki is ready
- `./start.sh --shortcut` (WSL on Windows) puts a "Start wiki" file on your Windows desktop to double-click
- `./start.sh --dev` runs the development server, which reloads as code changes
- `PORT=3001 ./start.sh` uses another port

Needs Node 22 or newer and git on the PATH. `npm run e2e` checks the whole propose and approve flow against a scripted mock model; `npm run mock-llm` runs that mock on port 4555 if you want to try the UI without a real model. Data lives in `./data` (set `WIKI_DATA_DIR` to move it):

- `data/wiki/` is a git repo of plain markdown files. Every approved or human edit is a commit under the person's name.
- `data/wiki.db` is SQLite: full-text search, proposals, approval log, and source records.

## Local models

Set `LOCAL_LLM_BASE_URL` to any OpenAI-compatible endpoint (Ollama: `http://localhost:11434/v1`) and `LOCAL_LLM_MODEL` to a model with good tool calling. When both providers are configured, a model picker appears in the chat panel. In this prototype the agent loop runs on the server, so the local model must be reachable from the server. Running the loop in the browser or in a companion app, so a remote wiki can use a model on your own machine, is the next step.

## How approval works

1. The assistant never writes to the wiki. Its tools stage proposals in SQLite.
2. The page shows each proposal inline: removed paragraphs struck through in red, added paragraphs in green, with Approve and Reject on every change plus Approve all and Reject all.
3. Approving writes the markdown and makes the git commit, with the source recorded in the commit message. The sidebar badges pages with pending changes.
4. Every proposal links to a `sources` row (who, kind, folder label, relative path, filename, content hash, version, message). The chip on each change and the Sources list at the bottom of each page read from it.

## Layout

- `lib/wiki.ts` markdown files, git, search
- `lib/diff.ts` paragraph-level diff and per-change apply
- `lib/proposals.ts` sources, change sets, approvals
- `lib/ai/` provider adapters (Anthropic, OpenAI-compatible), wiki tools, agent loop
- `app/api/` REST endpoints
- `components/` sidebar, page view with inline review, chat panel

## Not built yet

Drag and drop of documents and photos, folder and SharePoint watching, the companion app, per-folder "feeds wiki" or "personal only" visibility, and real auth. The names typed in the sidebar are not authenticated.
