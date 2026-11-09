import { NextRequest, NextResponse } from 'next/server';
import { addFolder, listFolders } from '@/lib/watcher';
import { accessFor } from '@/lib/access';
import { fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const viewer = requireUser(req);
  if (isResponse(viewer)) return viewer;
  const access = accessFor(viewer);
  return NextResponse.json(listFolders().filter((f) => access.folderAllowed(f.label)));
}

export async function POST(req: NextRequest) {
  try {
    const editor = requireUser(req, 'editor');
    if (isResponse(editor)) return editor;
    const b = await req.json();
    const folder = await addFolder({
      label: String(b.label ?? ''),
      path: String(b.path ?? ''),
      user: editor.name,
      fileExisting: b.fileExisting !== false,
      visibility: b.visibility === 'personal' ? 'personal' : 'wiki',
    });
    return NextResponse.json(folder);
  } catch (e) {
    return fail(e);
  }
}
