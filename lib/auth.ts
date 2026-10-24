import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { db } from '@/lib/db';

// Real accounts replace the typed names. Three roles, each including the ones before it:
//   viewer  read pages, search, chat
//   editor  everything a reader does, plus edit pages, review suggestions, drop files, watch folders
//   admin   everything an editor does, plus Settings (model address, key), librarian settings and People
// A person signs in with a name and password; the session is an HttpOnly cookie looked up in the
// database, so signing out works everywhere and nothing is trust-on-arrival. An external identity
// provider (Entra ID SSO) can later replace the login form without touching any of this plumbing.

export type Role = 'viewer' | 'editor' | 'admin';

export type SessionUser = { name: string; displayName: string; role: Role };

export const COOKIE_NAME = 'aiwiki_session';

// Sessions last 30 days from sign-in
const SESSION_DAYS = 30;

const rank: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

export function roleRank(role: string): number {
  return rank[role as Role] ?? -1;
}

const iso = (d: Date) => d.toISOString();

// ---------- passwords ----------

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ---------- accounts ----------

export type UserRow = { name: string; role: Role; password_hash: string | null; display_name: string | null; created_at: string };

// The display name is what edits and approvals show; a person is looked up by their username.
export const shownName = (row: Pick<UserRow, 'name' | 'display_name'>): string => row.display_name?.trim() || row.name;

export function countUsers(): number {
  return (db().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function listUsers(): { name: string; display: string; role: Role; created: string }[] {
  return (db().prepare('SELECT name, role, created_at, display_name FROM users ORDER BY created_at').all() as UserRow[]).map((u) => ({
    name: u.name,
    display: shownName(u),
    role: u.role,
    created: u.created_at,
  }));
}

export function getUser(name: string): UserRow | undefined {
  return db().prepare('SELECT * FROM users WHERE name = ?').get(name) as UserRow | undefined;
}

// Names are what people type to sign in, so look-ups ignore letter case.
export function findUser(name: string): UserRow | undefined {
  return db().prepare('SELECT * FROM users WHERE lower(name) = lower(?)').get(name) as UserRow | undefined;
}

export const PASSCODE_MIN = 8;

export function checkPassword(password: string): void {
  if (password.length < PASSCODE_MIN) throw new Error(`Use at least ${PASSCODE_MIN} characters for the password.`);
}

// The first account is set up on the login page ("Set up the wiki") and owns the place. After that,
// accounts are added on the Settings page by an admin. The display name defaults to the username.
export function createUser(name: string, role: Role, password: string | null, display?: string): UserRow {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Error('A username is needed.');
  if (clean.toLowerCase() === 'librarian') throw new Error('That username is reserved.');
  if (findUser(clean)) {
    throw new Error(`There is already someone named ${clean}. The username is what you sign in with, so it has to be unique.`);
  }
  if (!['viewer', 'editor', 'admin'].includes(role)) throw new Error('Unknown role.');
  checkPassword(password ?? '');
  const shown = display?.trim().slice(0, 60) || clean;
  const row: UserRow = {
    name: clean,
    role,
    password_hash: password ? hashPassword(password) : null,
    display_name: shown,
    created_at: iso(new Date()),
  };
  db().prepare('INSERT INTO users (name, role, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)').run(row.name, row.role, row.password_hash, row.display_name, row.created_at);
  return row;
}

// An admin can rename what a person's edits and approvals show; the username is untouched.
export function setDisplay(name: string, display: string): void {
  const clean = display?.trim().slice(0, 60);
  if (!clean) throw new Error('A display name is needed.');
  if (db().prepare('UPDATE users SET display_name = ? WHERE name = ?').run(clean, name).changes === 0) {
    throw new Error(`No account named ${name}.`);
  }
}

export function setRole(name: string, role: Role): void {
  if (!['viewer', 'editor', 'admin'].includes(role)) throw new Error('Unknown role.');
  if (db().prepare('UPDATE users SET role = ? WHERE name = ?').run(role, name).changes === 0) throw new Error(`No account named ${name}.`);
}

// An admin sets a colleague's password (they change it themselves in the menu);
// a person changes their own with the old one.
export function resetPassword(name: string, password: string): void {
  checkPassword(password);
  if (db().prepare('UPDATE users SET password_hash = ? WHERE name = ?').run(hashPassword(password), name).changes === 0) {
    throw new Error(`No account named ${name}.`);
  }
}

export function changeOwnPassword(name: string, current: string, next: string): void {
  const row = getUser(name);
  if (!row) throw new Error('No account.');
  if (!verifyPassword(current, row.password_hash)) throw new Error('The current password is wrong.');
  resetPassword(name, next);
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
      `SELECT u.name, u.role, u.display_name FROM sessions s JOIN users u ON u.name = s.user_name
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, iso(new Date())) as { name: string; role: Role; display_name: string | null } | undefined;
  return row ? { name: row.name, role: row.role, displayName: shownName(row) } : null;
}

export function destroySession(req: NextRequest): void {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (token) db().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Sign in with a name and password, creating the session cookie to set on the response. */
export function signIn(name: string, password: string): { user: SessionUser; token: string; maxAgeSeconds: number } {
  const row = findUser(name.trim());
  if (!row || !row.password_hash || !verifyPassword(password, row.password_hash)) {
    throw new Error('Wrong name or password.');
  }
  const { token, maxAgeSeconds } = createSession(row.name);
  return { user: { name: row.name, role: row.role, displayName: shownName(row) }, token, maxAgeSeconds };
}

// The wiki starts with no accounts: the login page offers "Set up the wiki" and the first account
// created this way is an admin.
export function needsSetup(): boolean {
  return countUsers() === 0;
}