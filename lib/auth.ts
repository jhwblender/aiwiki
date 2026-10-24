import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { db } from '@/lib/db';

// Real accounts replace the typed names. Three roles, each including the ones before it:
//   viewer  read pages, search, chat
//   editor  everything a reader does, plus edit pages, review suggestions, drop files, watch folders
//   admin   everything an editor does, plus Settings (model address, key), librarian settings and People
// A person signs in with a name and passcode; the session is an HttpOnly cookie looked up in the
// database, so signing out works everywhere and nothing is trust-on-arrival. An external identity
// provider (Entra ID SSO) can later replace the login form without touching any of this plumbing.

export type Role = 'viewer' | 'editor' | 'admin';

export type SessionUser = { name: string; role: Role };

export const COOKIE_NAME = 'aiwiki_session';

// Sessions last 30 days from sign-in
const SESSION_DAYS = 30;

const rank: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

export function roleRank(role: string): number {
  return rank[role as Role] ?? -1;
}

const iso = (d: Date) => d.toISOString();

// ---------- passcodes ----------

export function hashPasscode(passcode: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(passcode, salt, 32).toString('hex')}`;
}

export function verifyPasscode(passcode: string, stored: string | null): boolean {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(passcode, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ---------- accounts ----------

export type UserRow = { name: string; role: Role; passcode_hash: string | null; created_at: string };

export function countUsers(): number {
  return (db().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function listUsers(): { name: string; role: Role; created: string }[] {
  return (db().prepare('SELECT name, role, created_at FROM users ORDER BY created_at').all() as UserRow[]).map((u) => ({
    name: u.name,
    role: u.role,
    created: u.created_at,
  }));
}

export function getUser(name: string): UserRow | undefined {
  return db().prepare('SELECT * FROM users WHERE name = ?').get(name) as UserRow | undefined;
}

export const PASSCODE_MIN = 8;

export function checkPasscode(passcode: string): void {
  if (passcode.length < PASSCODE_MIN) throw new Error(`Use at least ${PASSCODE_MIN} characters for the passcode.`);
}

// The first account is set up on the login page ("Set up the wiki") and owns the place. After that,
// accounts are added on the Settings page by an admin.
export function createUser(name: string, role: Role, passcode: string | null): UserRow {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Error('A name is needed.');
  if (clean.toLowerCase() === 'librarian') throw new Error('That name is reserved.');
  if (!['viewer', 'editor', 'admin'].includes(role)) throw new Error('Unknown role.');
  checkPasscode(passcode ?? '');
  const row: UserRow = { name: clean, role, passcode_hash: passcode ? hashPasscode(passcode) : null, created_at: iso(new Date()) };
  db().prepare('INSERT INTO users (name, role, passcode_hash, created_at) VALUES (?, ?, ?, ?)').run(row.name, row.role, row.passcode_hash, row.created_at);
  return row;
}

export function setRole(name: string, role: Role): void {
  if (!['viewer', 'editor', 'admin'].includes(role)) throw new Error('Unknown role.');
  if (db().prepare('UPDATE users SET role = ? WHERE name = ?').run(role, name).changes === 0) throw new Error(`No account named ${name}.`);
}

// An admin sets a colleague's passcode (they change it themselves in the menu);
// a person changes their own with the old one.
export function resetPasscode(name: string, passcode: string): void {
  checkPasscode(passcode);
  if (db().prepare('UPDATE users SET passcode_hash = ? WHERE name = ?').run(hashPasscode(passcode), name).changes === 0) {
    throw new Error(`No account named ${name}.`);
  }
}

export function changeOwnPasscode(name: string, current: string, next: string): void {
  const row = getUser(name);
  if (!row) throw new Error('No account.');
  if (!verifyPasscode(current, row.passcode_hash)) throw new Error('The current passcode is wrong.');
  resetPasscode(name, next);
}

export function deleteUser(name: string, by: string): void {
  if (name === by) throw new Error('You cannot remove your own account while signed in.');
  db().transaction(() => {
    db().prepare('DELETE FROM sessions WHERE user_name = ?').run(name);
    if (db().prepare('DELETE FROM users WHERE name = ?').run(name).changes === 0) throw new Error(`No account named ${name}.`);
  })();
}

// ---------- sessions ----------

export function createSession(name: string): { token: string; maxAgeSeconds: number } {
  db().prepare('DELETE FROM sessions WHERE expires_at < ?').run(iso(new Date()));
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  db().prepare('INSERT INTO sessions (token, user_name, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, name, iso(now), iso(expires));
  return { token, maxAgeSeconds: SESSION_DAYS * 24 * 60 * 60 };
}

// The cookie value is the only credential the browser holds; it is meaningless without a row here.
export function sessionUser(req: NextRequest): SessionUser | null {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const row = db()
    .prepare(
      `SELECT u.name, u.role FROM sessions s JOIN users u ON u.name = s.user_name
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, iso(new Date())) as { name: string; role: Role } | undefined;
  return row ? { name: row.name, role: row.role } : null;
}

export function destroySession(req: NextRequest): void {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (token) db().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Sign in with a name and passcode, creating the session cookie to set on the response. */
export function signIn(name: string, passcode: string): { user: SessionUser; token: string; maxAgeSeconds: number } {
  const row = getUser(name.trim());
  if (!row || !row.passcode_hash || !verifyPasscode(passcode, row.passcode_hash)) {
    throw new Error('Wrong name or passcode.');
  }
  const { token, maxAgeSeconds } = createSession(row.name);
  return { user: { name: row.name, role: row.role }, token, maxAgeSeconds };
}

// The wiki starts with no accounts: the login page offers "Set up the wiki" and the first account
// created this way is an admin.
export function needsSetup(): boolean {
  return countUsers() === 0;
}