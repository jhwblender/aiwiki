import { NextRequest, NextResponse } from 'next/server';
import { accessFor, listGroups, rulesAt, setRules, WHOLE_WIKI, type RuleSet } from '@/lib/access';
import { listUsers } from '@/lib/auth';
import { normalizePath } from '@/lib/wiki';
import { denied, fail, requireUser, isResponse } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const pathOf = (raw: unknown) => (raw === WHOLE_WIKI ? WHOLE_WIKI : normalizePath(String(raw ?? '')));

// Who can use a page or section: its own rules, where its rules come from when it has none, and
// the groups and people that can be picked. Only people who manage the page get this far.
export async function GET(req: NextRequest) {
  try {
    const user = requireUser(req);
    if (isResponse(user)) return user;
    const p = pathOf(req.nextUrl.searchParams.get('path'));
    const access = accessFor(user);
    const no = denied(access, p, 'manage');
    if (no) return no;
    const from = access.ruleFrom(p);
    return NextResponse.json({
      path: p,
      rules: rulesAt(p),
      followsFrom: from !== p ? from : null,
      groups: listGroups().map((g) => ({ id: g.id, name: g.name, parentId: g.parentId })),
      people: listUsers().map((u) => ({ name: u.name, display: u.display })),
    });
  } catch (e) {
    return fail(e);
  }
}

// Replace a page's rules; { rules: null } removes them so it follows the section above
export async function PUT(req: NextRequest) {
  try {
    const user = requireUser(req);
    if (isResponse(user)) return user;
    const b = await req.json();
    const p = pathOf(b.path);
    const no = denied(accessFor(user), p, 'manage');
    if (no) return no;
    const rules: RuleSet | null = b.rules ? { everyone: b.rules.everyone, entries: Array.isArray(b.rules.entries) ? b.rules.entries.map((e: any) => ({ kind: e.kind, subject: String(e.subject), level: e.level })) : [] } : null;
    setRules(p, rules, user);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
