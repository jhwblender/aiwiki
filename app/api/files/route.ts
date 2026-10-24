import { NextRequest, NextResponse } from 'next/server';
import { MAX_FILES_PER_MESSAGE, saveUpload } from '@/lib/files';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Upload one or more files for the next chat message. Nothing is read or suggested yet;
// that happens when the message is sent.
export async function POST(req: NextRequest) {
  try {
    const user = requireUser(req, 'editor');
    if (isResponse(user)) return user;
    const form = await req.formData();
    const files = form.getAll('file').filter((f): f is File => typeof f !== 'string');
    if (!files.length) throw new Error('No file was received.');
    if (files.length > MAX_FILES_PER_MESSAGE) throw new Error(`Attach at most ${MAX_FILES_PER_MESSAGE} files at a time.`);
    const out = [];
    for (const f of files) {
      const saved = await saveUpload(f.name, Buffer.from(await f.arrayBuffer()), user.displayName);
      out.push({ id: saved.id, name: saved.filename, mime: saved.mime, size: saved.size, kind: saved.kind });
    }
    return NextResponse.json(out);
  } catch (e) {
    return fail(e);
  }
}
