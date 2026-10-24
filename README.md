# AI Wiki

**A wiki that keeps itself up to date, without ever changing a word on its own.**

Tell the assistant something new, drop in a document, or point it at a shared folder. It reads, works out which pages are affected, and suggests the edits. The suggestions appear right on the page, highlighted like tracked changes, and anyone reviewing approves or rejects them with one click. Nothing is published until a person says yes.

Everything is plain Markdown in a git repository, every change records where it came from, and it runs fully on your own hardware with a local model if you want it to.

---

## Why

Team wikis rot. The knowledge exists, in chat threads, PDFs, SharePoint folders and people's heads, but nobody has time to copy it into the right page. AI can do the copying, but nobody wants an AI quietly rewriting the documentation they rely on.

AI Wiki splits the job: **the AI does the reading and writing, people make every decision.** Reviewers do not need to know Markdown, git or diffs. They see the page with the suggested change highlighted, a note on where it came from, and two buttons.

## What it does

**Suggests, never publishes**
- The assistant's tools can only stage suggestions. Only a human approval writes to the wiki
- Suggestions appear inline on the page: additions in green, removals struck through in red, and the exact words that changed highlighted inside an edited paragraph or table
- Approve or reject each change, or the whole suggestion at once
- Suggestions stay correct when the page changes underneath them; if two edits overlap, the older one is flagged instead of silently undoing the newer one

**Feeds itself**
- **Chat:** "the review day moved to Tuesday" becomes a suggested edit on the right page
- **Files:** drop PDFs, Word documents, text files, photos and scanned PDFs into the chat or onto a page. Text is extracted, photos and scans are read by a vision model
- **Watched folders:** point it at a folder (a OneDrive-synced SharePoint library works) and new or changed documents are filed in the background
- **Updated documents** are reduced to what changed, so the wiki gets an edit instead of a duplicate; files it has already seen are skipped

**Knows where everything came from**
- Every suggestion links to its source: who sent it, the file, its folder and path, its version and a fingerprint of its content
- Each page lists its sources; the original file opens with one click
- Approvals are recorded in git under the approver's name, with the sources in the commit message

**Helps, not just files**
- Answers questions from the wiki, and from the original documents when the wiki does not cover something yet (and says so)
- Sees pending suggestions, so it does not suggest the same thing twice; a follow-up message revises its own earlier suggestion
- Suggests moving, renaming, splitting and merging pages; links are rewritten when a page moves
- Shows its progress live while it works, and keeps working if you close the chat
- **Librarian:** keeps the wiki organised on its own. It settles the sections, writes overview pages, keeps the home page a map of the wiki, merges duplicates, moves misplaced pages and fixes broken links, using the watched folders to see what belongs together. Every change is a suggestion like any other

**Runs where you want**
- Any OpenAI-compatible local server (Ollama, LM Studio, vLLM), or Anthropic's Claude
- A connection test in Settings checks the server, the model, tool use and image reading, and explains any failure in plain words

## Quick start

Needs Node 22 or newer and git — or let `./start.sh` download Node 22 for you on the first run (no administrator password).

```bash
git clone https://github.com/jhwblender/aiwiki.git
cd aiwiki
./start.sh
```

Open the address `./start.sh` prints (http://localhost:3000, unless that port is taken — then it moves to the next free one), go to **Settings**, and connect a model:

- **Ollama:** click *Ollama* to fill in `http://localhost:11434/v1`, pick a model with tool calling (Qwen 2.5 or newer, Llama 3.1 or newer), then *Test connection*
- **Claude:** add `ANTHROPIC_API_KEY` to `.env.local` and run `./start.sh` again

`./start.sh` checks for Node, npm and git, offers to download Node 22 if it is missing (into `~/.local/share/aiwiki/node`, no administrator password), installs the packages on the first run (or after the package list changes), builds only when the code changed, and starts the wiki. If port 3000 is taken it uses the next free port and says which one; `./stop.sh` follows it. Other options:

```bash
./start.sh --open       # open the browser when ready
./start.sh --shortcut   # WSL: put a "Start wiki" launcher on the Windows desktop
./start.sh --dev        # development server with live reload
PORT=4000 ./start.sh    # start from another port (busy ports fall back to the next free one)
```

No model handy? `npm run mock-llm` starts a scripted test model on port 4555 so you can click through the whole flow.

## How it fits together

```
 chat message ─┐
 dropped file ─┼─► source record ─► assistant (search, read, suggest) ─► suggestion ─► review on the page ─► git commit
watched folder ┘        ▲                       │                                         (Approve / Reject)
                        └── original file, version, folder path ◄──┘
```

| Part | What it is |
| --- | --- |
| Pages | Markdown files in `data/wiki/`, a git repository; every edit is a commit under the person's name |
| Search, suggestions, sources | SQLite in `data/wiki.db` (full-text search over pages and documents) |
| Originals | Stored once per content under `data/assets/` |
| App | One Next.js app serving the UI and a REST API |
| Assistant | A provider-neutral tool loop; the same tools work with local models and Claude |

Design rules the code keeps:

1. Markdown in git is the source of truth
2. The AI never writes to the wiki; only human approval does
3. Review happens on the page itself; there is no separate review queue
4. No git words in the UI; reviewers see highlights and Approve or Reject
5. Every suggestion links to a source record
6. Works the same with local models and hosted ones

More detail for contributors is in [CLAUDE.md](CLAUDE.md).

## Testing

```bash
npm run e2e
```

Starts a scripted mock model and a throwaway wiki, then drives the whole flow through the API: chat, file drops (including a generated scanned PDF and photo), background filing, watched folders, the librarian, page moves, conflicts and approvals. Over 200 checks, no model or network needed.

## Status

A working prototype in daily use by one team. It runs on a single machine; there are no real logins yet, so run it only where everyone who can reach it is trusted.

Next up: conflict handling between sources, bulk review, a companion desktop app, and sign-in with roles. The full plan is in [CLAUDE.md](CLAUDE.md).

## License

MIT. See [LICENSE](LICENSE).
