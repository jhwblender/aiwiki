import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Lets Settings browse folders on the wiki server to pick one to watch. Only folder names are
// listed, plus how many documents a folder holds directly; file contents are never read here.

const DOC_EXT = new Set(['.pdf', '.docx', '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
const HIDDEN = /^(\.|\$|~)|^(node_modules|appdata|application data|local settings|ntuser\.dat.*|system volume information|windows|program files.*|programdata|recovery|perflogs)$/i;
const MAX_ENTRIES = 500;

// C:\ style for folders on Windows drives seen from WSL, so they look familiar
export function displayPath(p: string): string {
  const m = p.match(/^\/mnt\/([a-z])(\/.*)?$/);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/^\//, '').replace(/\//g, '\\')}`;
}

async function isDir(p: string) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export type Shortcut = { label: string; path: string; display: string };

// Places to start from: Windows user folders (Desktop, Documents, OneDrive), drives, the server home
export async function shortcuts(): Promise<Shortcut[]> {
  const out: Shortcut[] = [];
  const add = async (label: string, p: string) => {
    if (!out.some((s) => s.path === p) && (await isDir(p))) out.push({ label, path: p, display: displayPath(p) });
  };
  try {
    const users: string[] = [];
    for (const user of await fs.readdir('/mnt/c/Users')) {
      if (HIDDEN.test(user) || /^(all users|default|default user|public|_)/i.test(user)) continue;
      if (await isDir(path.join('/mnt/c/Users', user, 'Desktop'))) users.push(user);
    }
    // With one Windows account the folder names alone are clear
    const named = (user: string, label: string) => (users.length > 1 ? `${user}: ${label}` : label);
    for (const user of users) {
      const home = path.join('/mnt/c/Users', user);
      // Work or school OneDrive ("OneDrive - Company") first; that is where SharePoint libraries sync
      const drives = (await fs.readdir(home).catch(() => [] as string[])).filter((e) => /^OneDrive/i.test(e));
      drives.sort((a, b) => Number(/^OneDrive - /i.test(b)) - Number(/^OneDrive - /i.test(a)) || a.localeCompare(b));
      for (const entry of drives) await add(named(user, entry), path.join(home, entry));
      await add(named(user, 'Documents'), path.join(home, 'Documents'));
      await add(named(user, 'Desktop'), path.join(home, 'Desktop'));
      await add(users.length > 1 ? user : 'Windows user folder', home);
    }
  } catch {}
  for (const drive of await fs.readdir('/mnt').catch(() => [] as string[])) {
    if (/^[a-z]$/.test(drive)) await add(`${drive.toUpperCase()}: drive`, `/mnt/${drive}`);
  }
  await add('Wiki server home', os.homedir());
  return out;
}

export async function browse(dir: string) {
  const abs = path.resolve(dir);
  if (!(await isDir(abs))) throw new Error(`The wiki server cannot open ${displayPath(abs)}.`);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const dirs: { name: string; path: string }[] = [];
  let docs = 0;
  for (const e of entries) {
    if (e.isDirectory() && !HIDDEN.test(e.name)) dirs.push({ name: e.name, path: path.join(abs, e.name) });
    else if (e.isFile() && !e.name.startsWith('~$') && DOC_EXT.has(path.extname(e.name).toLowerCase())) docs++;
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(abs);
  return {
    path: abs,
    display: displayPath(abs),
    name: path.basename(abs) || abs,
    parent: parent !== abs ? parent : null,
    dirs: dirs.slice(0, MAX_ENTRIES),
    more: Math.max(0, dirs.length - MAX_ENTRIES),
    docs,
  };
}
