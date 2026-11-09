import { db } from './db';

// Who may see and do what, page by page. Roles (lib/auth.ts) stay as the wiki-wide starting point;
// groups and section rules refine them:
//   Groups form a tree, and belonging to a group also means belonging to every group above it.
//   Rules sit on a page or section and cover everything under it. The nearest rule decides, and
//   replaces whatever is above it, so a section with rules is limited to the people those rules name.
//   With no rule anywhere a person gets what their role gives. Admins can always do everything.
// Someone who can suggest uses the editor as usual, but what they save waits for approval on the page.
// The rules live here rather than in the pages: they are not page content and are not reviewed.

export type Level = 'none' | 'read' | 'suggest' | 'edit' | 'approve' | 'manage';
export type EveryoneLevel = 'none' | 'role' | 'read' | 'suggest' | 'edit' | 'approve';
export type GrantLevel = 'read' | 'suggest' | 'edit' | 'approve' | 'manage';

const RANK: Record<Level, number> = { none: 0, read: 1, suggest: 2, edit: 3, approve: 4, manage: 5 };
const GRANTS: GrantLevel[] = ['read', 'suggest', 'edit', 'approve', 'manage'];
const EVERYONE: EveryoneLevel[] = ['none', 'role', 'read', 'suggest', 'edit', 'approve'];

// A rule at this path covers every page, below any section rule
export const WHOLE_WIKI = '*';

export type Who = { name: string; role: string };
// No account and no groups: what is open to anyone. The librarian's own runs and unknown names work as this.
export const NOBODY: Who = { name: '', role: 'viewer' };

type RuleRow = { path: string; kind: 'everyone' | 'group' | 'user'; subject: string; level: string };

export type Access = {
  name: string;
  groupIds: number[];
  level: (path: string) => Level;
  can: (path: string, need: Level) => boolean;
  visible: (path: string) => boolean;
  ruleFrom: (path: string) => string | null; // the path of the rule that decides this page, if any
  folderAllowed: (label: string | null | undefined) => boolean;
};

function chain(path: string): string[] {
  if (path === WHOLE_WIKI) return [WHOLE_WIKI];
  const out: string[] = [];
  for (let p = path; p; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') out.push(p);
  out.push(WHOLE_WIKI);
  return out;
}

// A person's groups, with every group above each of them
function groupsOf(name: string): number[] {
  if (!name) return [];
  const parents = new Map((db().prepare('SELECT id, parent_id FROM user_groups').all() as { id: number; parent_id: number | null }[]).map((g) => [g.id, g.parent_id]));
  const out = new Set<number>();
  for (const { group_id } of db().prepare('SELECT group_id FROM group_members WHERE user_name = ?').all(name) as { group_id: number }[]) {
    for (let g: number | null | undefined = group_id; g != null && !out.has(g); g = parents.get(g)) out.add(g);
  }
  return [...out];
}

export function accessFor(who: Who): Access {
  const admin = who.role === 'admin';
  const roleLevel: Level = admin ? 'manage' : who.role === 'editor' ? 'approve' : 'read';
  const groupIds = admin
    ? (db().prepare('SELECT id FROM user_groups').all() as { id: number }[]).map((g) => g.id)
    : groupsOf(who.name);
  const mine = new Set(groupIds.map(String));
  const rules = new Map<string, RuleRow[]>();
  for (const r of db().prepare('SELECT * FROM page_access').all() as RuleRow[]) {
    if (!rules.has(r.path)) rules.set(r.path, []);
    rules.get(r.path)!.push(r);
  }
  const folders = new Map((db().prepare('SELECT label, access_group FROM watched_folders').all() as { label: string; access_group: number | null }[]).map((f) => [f.label, f.access_group]));

  const ruleFrom = (path: string) => chain(path).find((at) => rules.has(at)) ?? null;
  const level = (path: string): Level => {
    if (admin) return 'manage';
    const at = ruleFrom(path);
    if (at === null) return roleLevel;
    let best: Level = 'none';
    for (const r of rules.get(at)!) {
      const applies = r.kind === 'everyone' || (r.kind === 'user' ? r.subject === who.name : mine.has(r.subject));
      if (!applies) continue;
      const v = (r.level === 'role' ? roleLevel : r.level) as Level;
      if (RANK[v] > RANK[best]) best = v;
    }
    return best;
  };
  const can = (path: string, need: Level) => RANK[level(path)] >= RANK[need];
  return {
    name: who.name,
    groupIds,
    level,
    can,
    visible: (path) => can(path, 'read'),
    ruleFrom,
    folderAllowed: (label) => {
      if (admin || !label) return true;
      const g = folders.get(label);
      return g == null || groupIds.includes(g);
    },
  };
}

// Background jobs only know the name they were queued under: a username, or a display name when
// the job came from a person's drop. A name that is unknown or shared by two people gets nothing extra.
export function accessForName(name: string): Access {
  const d = db();
  const exact = d.prepare('SELECT name, role FROM users WHERE name = ?').get(name) as Who | undefined;
  if (exact) return accessFor(exact);
  const shown = d.prepare('SELECT name, role FROM users WHERE display_name = ?').all(name) as Who[];
  return accessFor(shown.length === 1 ? shown[0] : NOBODY);
}

// An original file opens for someone who can read a page it fed. A file that never reached a page
// has nothing to protect it by, so only its folder's limit applies.
export function sourcesAllowed(access: Access, sourceIds: number[]): boolean {
  const d = db();
  return sourceIds.some((id) => {
    const s = d.prepare('SELECT folder_label FROM sources WHERE id = ?').get(id) as { folder_label: string | null } | undefined;
    if (!access.folderAllowed(s?.folder_label)) return false;
    const pages = d
      .prepare(
        `SELECT page_path AS p FROM page_sources WHERE source_id = ?
         UNION SELECT pr.page_path FROM proposals pr JOIN change_sets cs ON cs.id = pr.change_set_id WHERE cs.source_id = ?
         UNION SELECT pr.page_path FROM proposals pr JOIN change_set_sources x ON x.change_set_id = pr.change_set_id WHERE x.source_id = ?`,
      )
      .all(id, id, id) as { p: string }[];
    return !pages.length || pages.some((r) => access.visible(r.p));
  });
}

// ---------- groups ----------

export type GroupInfo = { id: number; name: string; parentId: number | null; members: string[] };

export function listGroups(): GroupInfo[] {
  const d = db();
  const members = new Map<number, string[]>();
  for (const m of d.prepare('SELECT group_id, user_name FROM group_members ORDER BY user_name').all() as { group_id: number; user_name: string }[]) {
    members.set(m.group_id, [...(members.get(m.group_id) ?? []), m.user_name]);
  }
  return (d.prepare('SELECT id, name, parent_id FROM user_groups ORDER BY name').all() as { id: number; name: string; parent_id: number | null }[]).map((g) => ({
    id: g.id,
    name: g.name,
    parentId: g.parent_id,
    members: members.get(g.id) ?? [],
  }));
}

function cleanGroupName(name: string): string {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Error('A group needs a name.');
  return clean;
}

function assertGroup(id: number) {
  if (!db().prepare('SELECT 1 FROM user_groups WHERE id = ?').get(id)) throw new Error('That group no longer exists.');
}

function assertFreeName(name: string, except?: number) {
  const other = db().prepare('SELECT id FROM user_groups WHERE lower(name) = lower(?)').get(name) as { id: number } | undefined;
  if (other && other.id !== except) throw new Error(`There is already a group called ${name}.`);
}

export function createGroup(name: string, parentId: number | null): number {
  const clean = cleanGroupName(name);
  assertFreeName(clean);
  if (parentId !== null) assertGroup(parentId);
  return Number(db().prepare('INSERT INTO user_groups (name, parent_id, created_at) VALUES (?, ?, ?)').run(clean, parentId, new Date().toISOString()).lastInsertRowid);
}

export function updateGroup(id: number, change: { name?: string; parentId?: number | null; members?: string[] }): void {
  const d = db();
  assertGroup(id);
  d.transaction(() => {
    if (change.name !== undefined) {
      const clean = cleanGroupName(change.name);
      assertFreeName(clean, id);
      d.prepare('UPDATE user_groups SET name = ? WHERE id = ?').run(clean, id);
    }
    if (change.parentId !== undefined) {
      // Walk up from the new parent: reaching this group means it would end up inside itself
      const up = d.prepare('SELECT parent_id FROM user_groups WHERE id = ?');
      for (let g = change.parentId; g !== null; g = (up.get(g) as { parent_id: number | null }).parent_id) {
        assertGroup(g);
        if (g === id) throw new Error('A group cannot sit inside itself or one of its own sub-groups.');
      }
      d.prepare('UPDATE user_groups SET parent_id = ? WHERE id = ?').run(change.parentId, id);
    }
    if (change.members !== undefined) {
      d.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
      const add = d.prepare('INSERT OR IGNORE INTO group_members (group_id, user_name) VALUES (?, ?)');
      for (const name of change.members) {
        if (!d.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) throw new Error(`No account named ${name}.`);
        add.run(id, name);
      }
    }
  })();
}

// Sub-groups move up a level. A section's rules for the group go with it, and the section stays
// limited to whoever else it names, so deleting a group can only ever take access away.
export function deleteGroup(id: number): void {
  const d = db();
  assertGroup(id);
  const folder = d.prepare('SELECT label FROM watched_folders WHERE access_group = ?').get(id) as { label: string } | undefined;
  if (folder) throw new Error(`The watched folder ${folder.label} is limited to this group. Change that first.`);
  d.transaction(() => {
    const { parent_id } = d.prepare('SELECT parent_id FROM user_groups WHERE id = ?').get(id) as { parent_id: number | null };
    d.prepare('UPDATE user_groups SET parent_id = ? WHERE parent_id = ?').run(parent_id, id);
    d.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
    d.prepare("DELETE FROM page_access WHERE kind = 'group' AND subject = ?").run(String(id));
    d.prepare('DELETE FROM user_groups WHERE id = ?').run(id);
  })();
}

export function setFolderGroup(folderId: number, groupId: number | null): void {
  if (groupId !== null) assertGroup(groupId);
  db().prepare('UPDATE watched_folders SET access_group = ? WHERE id = ?').run(groupId, folderId);
}

// ---------- rules ----------

export type RuleEntry = { kind: 'group' | 'user'; subject: string; level: GrantLevel };
export type RuleSet = { everyone: EveryoneLevel; entries: RuleEntry[] };

export function rulesAt(path: string): RuleSet | null {
  const rows = db().prepare('SELECT * FROM page_access WHERE path = ?').all(path) as RuleRow[];
  if (!rows.length) return null;
  return {
    everyone: (rows.find((r) => r.kind === 'everyone')?.level ?? 'none') as EveryoneLevel,
    entries: rows.filter((r) => r.kind !== 'everyone').map((r) => ({ kind: r.kind as 'group' | 'user', subject: r.subject, level: r.level as GrantLevel })),
  };
}

// Replace the rules on a path, or remove them with null so it follows the rules above it. Someone
// who is not an admin cannot save rules that would take away their own right to change them.
export function setRules(path: string, rules: RuleSet | null, by: Who): void {
  const d = db();
  d.transaction(() => {
    d.prepare('DELETE FROM page_access WHERE path = ?').run(path);
    if (rules) {
      if (!EVERYONE.includes(rules.everyone)) throw new Error('Unknown level for everyone else.');
      const add = d.prepare('INSERT OR REPLACE INTO page_access (path, kind, subject, level) VALUES (?, ?, ?, ?)');
      // This row is always written, so a section keeps its limit even when every name on it is later removed
      add.run(path, 'everyone', '', rules.everyone);
      for (const e of rules.entries) {
        if (!GRANTS.includes(e.level)) throw new Error('Unknown level.');
        const known = e.kind === 'group' ? d.prepare('SELECT 1 FROM user_groups WHERE id = ?').get(Number(e.subject)) : e.kind === 'user' && d.prepare('SELECT 1 FROM users WHERE name = ?').get(e.subject);
        if (!known) throw new Error('One of those groups or people no longer exists.');
        add.run(path, e.kind, e.subject, e.level);
      }
    }
    if (!accessFor(by).can(path, 'manage')) throw new Error('These rules would remove your own right to manage this page. Keep yourself on the list as Can manage.');
  })();
}

// Rules travel with a page when it moves, so moving a private page never opens it
export function moveRules(from: string, to: string): void {
  const d = db();
  const paths = (d.prepare('SELECT DISTINCT path FROM page_access').all() as { path: string }[]).map((r) => r.path).filter((p) => p === from || p.startsWith(from + '/'));
  for (const p of paths) {
    const next = to + p.slice(from.length);
    d.prepare('DELETE FROM page_access WHERE path = ?').run(next);
    d.prepare('UPDATE page_access SET path = ? WHERE path = ?').run(next, p);
  }
}
