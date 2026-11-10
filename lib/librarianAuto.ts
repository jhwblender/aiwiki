import { db } from './db';
import { AUTO_USER, inSchedule, librarianSettings, listSections, WHOLE } from './librarian';
import { enqueueTidy, isPaused } from './queue';
import { lastChanged } from './wiki';

// The librarian tidies on its own. Every few minutes it looks for a part of the wiki that changed
// since it last looked, once filing is done and the changes have settled, and queues one tidy run:
// the whole wiki first (the sections, the home page), then each changed section. A part with
// librarian suggestions still waiting for review is left until people have decided on them, and a
// run whose survey finds nothing ends without asking the model. A part that has not changed since
// its last run is never run again. A paused queue holds it too, and so do the days and hours set on
// Settings.

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
  const { auto, schedule } = librarianSettings();
  if (!auto || !inSchedule(schedule)) return null;
  const d = db();
  if (d.prepare("SELECT 1 FROM ingest_jobs WHERE mode = 'tidy' AND status IN ('queued', 'working')").get()) return null;
  // A pause holds the librarian too: no run is queued and no survey started until resume
  if (isPaused()) return null;
  const filing = d.prepare("SELECT status FROM ingest_jobs WHERE mode != 'tidy' AND status IN ('queued', 'working')").all() as { status: string }[];
  if (filing.length) return null;

  const now = Date.now();
  const scopes = [WHOLE, ...(await listSections()).map((s) => s.section)];
  for (const scope of scopes) {
    const changedAt = await lastChanged(scope === WHOLE ? undefined : scope);
    if (!changedAt || now - changedAt < schedule.quietMinutes * 60_000) continue;
    const last = lastTidy(scope);
    if (last >= changedAt || now - last < (scope === WHOLE ? schedule.wholeHours : schedule.sectionHours) * 3_600_000) continue;
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
