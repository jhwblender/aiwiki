import path from 'node:path';
import { db } from './db';

// Where a file from a watched folder sits, for the assistant: its path, its neighbours, and a compact
// outline of the folder tree with file counts. Built from what the watcher already recorded, so
// nothing is read from disk. A hint about where things belong, not a structure to copy.

const MAX_DIRS = 60;
const MAX_NEIGHBOURS = 12;

export function folderContext(folderLabel: string, relPath: string | null | undefined): string {
  const folder = db().prepare('SELECT id FROM watched_folders WHERE label = ?').get(folderLabel) as { id: number } | undefined;
  const lines = [`Watched folder: "${folderLabel}"`];
  if (relPath) lines.push(`Path in folder: ${relPath}`);
  if (!folder) return lines.join('\n');

  const files = (db().prepare('SELECT rel_path FROM watched_files WHERE folder_id = ?').all(folder.id) as { rel_path: string }[]).map(
    (r) => r.rel_path,
  );
  const fileDir = relPath ? path.posix.dirname(relPath) : '.';

  // Files directly in each folder, and in each folder with everything under it
  const direct = new Map<string, number>();
  const total = new Map<string, number>();
  for (const f of files) {
    const dir = path.posix.dirname(f);
    direct.set(dir, (direct.get(dir) ?? 0) + 1);
    for (let d = dir; ; d = path.posix.dirname(d)) {
      total.set(d, (total.get(d) ?? 0) + 1);
      if (d === '.') break;
    }
  }

  const neighbours = files.filter((f) => f !== relPath && path.posix.dirname(f) === fileDir).map((f) => path.posix.basename(f));
  if (neighbours.length) {
    lines.push(
      `Other files in the same folder: ${neighbours.slice(0, MAX_NEIGHBOURS).join(', ')}` +
        (neighbours.length > MAX_NEIGHBOURS ? `, and ${neighbours.length - MAX_NEIGHBOURS} more` : ''),
    );
  }

  // Large trees: keep the top level, the way down to this file, and what sits beside each step
  let dirs = [...total.keys()].filter((d) => d !== '.').sort();
  if (dirs.length > MAX_DIRS) {
    const ancestors = new Set<string>();
    for (let d = fileDir; d !== '.'; d = path.posix.dirname(d)) ancestors.add(d);
    const keep = (d: string) => {
      const parent = path.posix.dirname(d);
      return parent === '.' || ancestors.has(d) || ancestors.has(parent);
    };
    dirs = dirs.filter(keep).slice(0, MAX_DIRS);
  }
  if (dirs.length) {
    lines.push(`Folder outline (${files.length} files in all):`);
    for (const d of dirs) {
      const depth = d.split('/').length - 1;
      const count = total.get(d) ?? 0;
      const mark = d === fileDir ? '   <- this file' : '';
      lines.push(`${'  '.repeat(depth)}- ${path.posix.basename(d)}/ (${count} file${count === 1 ? '' : 's'})${mark}`);
    }
    const loose = direct.get('.') ?? 0;
    if (loose) lines.push(`- (${loose} file${loose === 1 ? '' : 's'} directly in the folder)${fileDir === '.' ? '   <- this file' : ''}`);
  }
  return lines.join('\n');
}
