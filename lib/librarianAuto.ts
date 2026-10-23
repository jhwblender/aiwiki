import { db } from './db';
import { AUTO_USER, librarianSettings, listSections, WHOLE } from './librarian';
import { enqueueTidy, isPaused } from './queue';
import { lastChanged } from './wiki';

// The librarian tidies on its own. Every few minutes it looks for a part of the wiki that changed
// since it last looked, once filing is done and the changes have settled, and queues one tidy run:
// the whole wiki first (the sections, the home page), then each changed section. A part with
// librarian suggestions still waiting for review is left until people have decided on them, and a
// run whose survey finds nothing ends without asking the model.

const secs = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return (Number.isFinite(v) && v >= 0 ? v : fallback) * 1000;
};
// how long the wiki must be quiet, and how long between runs over the same part
const QUIET = () => secs('LIBRARIAN_QUIET_SECONDS', 30 * 60);
const SECTION_GAP = () => secs('LIBRARIAN_SECTION_GAP_SECONDS', 2 * 60 * 60);
const WHOLE_GAP = () => secs('LIBRARIAN_WHOLE_GAP_SECONDS', 24 * 60 * 60);

// When the librarian last ran (or was asked to run) over this part, by anyone
function lastTidy(section: string): number {
  const r = db().prepare('SELECT MAX(created_at) AS at FROM ingest_jobs WHERE doc_key = ?').get(`tidy:${section}`) as { at: string | null };
  return r.at ? new Date(r.at).getTime() : 0;
}

// Librarian suggestions in this part (anywhere, for the whole wiki) still waiting for review
function awaitingReview(section: string): boolean {
  const where = section === WHOLE ? '' : 'AND (x.page_path = ? OR x.page_path LIKE ?)';
  const args = section === WHOLE ? [] : [section, `${section}/%`];
  const q = (table: string) =>
    db()
      .prepare(
        `SELECT 1 FROM ${table} x JOIN change_sets cs ON cs.id = x.change_set_id JOIN sources s ON s.id = cs.source_id
         WHERE x.status = 'pending' AND s.kind = 'librarian' ${where} LIMIT 1`,
      )
      .get(...args);
  return !!(q('proposals') || q('page_ops'));
}

// Queue the next tidy run that is due, if any; returns its scope
export async function checkLibrarian(): Promise<string | null> {
  if (!librarianSettings().auto) return null;
  const d = db();
  if (d.prepare("SELECT 1 FROM ingest_jobs WHERE mode = 'tidy' AND status IN ('queued', 'working')").get()) return null;
  // Wait for a batch of filing to finish; a paused backlog does not count as running
  const filing = d.prepare("SELECT status FROM ingest_jobs WHERE mode != 'tidy' AND status IN ('queued', 'working')").all() as { status: string }[];
  if (filing.some((j) => j.status === 'working') || (filing.length && !isPaused())) return null;

  const now = Date.now();
  const scopes = [WHOLE, ...(await listSections()).map((s) => s.section)];
  for (const scope of scopes) {
    const changedAt = await lastChanged(scope === WHOLE ? undefined : scope);
    if (!changedAt || now - changedAt < QUIET()) continue;
    const last = lastTidy(scope);
    if (last >= changedAt || now - last < (scope === WHOLE ? WHOLE_GAP() : SECTION_GAP())) continue;
    if (awaitingReview(scope)) continue;
    enqueueTidy({ section: scope, user: AUTO_USER });
    return scope;
  }
  return null;
}

const g = globalThis as unknown as { __librarianTimer?: NodeJS.Timeout };

export function startLibrarian() {
  if (g.__librarianTimer) clearInterval(g.__librarianTimer);
  const seconds = Math.max(10, Number(process.env.LIBRARIAN_CHECK_SECONDS) || 300);
  g.__librarianTimer = setInterval(() => void checkLibrarian().catch((e) => console.error('[librarian]', e?.message ?? e)), seconds * 1000);
}
