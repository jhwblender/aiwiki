import { NextRequest, NextResponse } from 'next/server';
import { addFolder, listFolders } from '@/lib/watcher';
import { fail, userFrom } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(listFolders());
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const folder = await addFolder({
      label: String(b.label ?? ''),
      path: String(b.path ?? ''),
      user: userFrom(b.user),
      fileExisting: b.fileExisting !== false,
    });
    return NextResponse.json(folder);
  } catch (e) {
    return fail(e);
  }
}
