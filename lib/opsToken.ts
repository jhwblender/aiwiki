import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './db';

// A secret for the update script, written at startup to a file only the wiki's own account can
// read. The script reads it from inside the server (docker exec), so nobody reaching the wiki over
// the network can ask it to hold or report its work. One file per data folder, so two wikis on one
// machine never share it.
export function opsTokenFile(): string {
  const tag = crypto.createHash('sha256').update(DATA_DIR).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `aiwiki-ops-${tag}`);
}

export function writeOpsToken() {
  const file = opsTokenFile();
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
}

export function opsTokenMatches(given: string | null): boolean {
  if (!given) return false;
  let want: Buffer;
  try {
    want = fs.readFileSync(opsTokenFile());
  } catch {
    return false;
  }
  const got = Buffer.from(given);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
