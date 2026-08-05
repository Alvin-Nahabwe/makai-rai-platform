import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContext, requireOrgContextWithIdentity } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { lookupUserNames } from '@/lib/data/identity';
import { toResponse } from '@/lib/http/toResponse';

/**
 * `ROUTE_ACTIONS` (lib/authz/routeActions.ts) declares only GET and PATCH
 * for this route. The pre-tenancy version also exposed a bulk-create POST
 * (`remediationItem.createMany`) with no caller anywhere in the app (a
 * codebase-wide grep for its only client, `/remediation` POST, found none —
 * `AGENTS.md` §2: "touching a file the brief did not name -> ask whether it
 * is in scope"). Not carried forward: porting dead, uncalled surface area
 * onto the tenant boundary is scope this task's map does not authorize, and
 * a POST added here without a declared action would fail
 * `port-completeness.test.ts`'s "every route declares an action" check by
 * design. If a future task needs bulk remediation creation, it gets its own
 * `ROUTE_ACTIONS` entry.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    const ctx = await requireOrgContext(slug, 'assessment:read');
    // No `completedBy` relation `include` — `makrai_app` has no grant on
    // `users` (lib/data/identity.ts#lookupUserNames). `completedById` is
    // read as a scalar column and names attached afterwards.
    const items = await withOrg(ctx, (tx) =>
      tx.remediationItem.findMany({
        where: { assessmentId: id },
        orderBy: [{ tier: 'asc' }, { createdAt: 'asc' }],
      }),
    );
    const names = await lookupUserNames(
      items.map((i) => i.completedById).filter((v): v is string => v !== null),
    );
    const withNames = items.map((i) => ({
      ...i,
      completedBy: i.completedById ? (names.get(i.completedById) ?? null) : null,
    }));
    return NextResponse.json(withNames);
  } catch (e) {
    return toResponse(e);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'remediation:update');

    const body = await req.json();
    const { itemId, completed, completionNotes, evidenceLevel } = body;
    if (!itemId) return NextResponse.json({ error: 'itemId is required' }, { status: 400 });

    const item = await withOrg(ctx, async (tx) => {
      // The item must belong to THIS assessment — never trust a raw itemId
      // that could point at another assessment's remediation item. RLS
      // already confines `itemId` to this org; this confines it further,
      // within the org, to the assessment named in the URL — a domain
      // check, not a tenant one.
      const existing = await tx.remediationItem.findUnique({
        where: { id: itemId },
        select: { assessmentId: true },
      });
      if (!existing || existing.assessmentId !== id) return null;

      // IMPORTANT-1 (final Plan 1b review): `completedAt`/`completedById`
      // must follow `completed` the SAME way `completed` follows itself —
      // `undefined` when the field is absent from the body, so a PATCH that
      // sends only `completionNotes`/`evidenceLevel` cannot silently erase
      // who completed the item and when. They were previously unconditional
      // (`completed ? … : null`), which nulled both on every partial PATCH
      // of an already-completed item — silent corruption of the ISO-42001
      // evidence trail this field exists to preserve.
      return tx.remediationItem.update({
        where: { id: itemId },
        data: {
          completed: completed ?? undefined,
          // Single `completed !== undefined` guard, not one repeated per
          // field: the previous form duplicated the guard across
          // `completedAt` and `completedById`, which is exactly the shape
          // that would silently miss a THIRD `completed`-derived field if
          // one is ever added. Same "field present in body -> set, else
          // omit" conditional-spread idiom already used by the projects
          // PATCH route (app/api/v1/orgs/[slug]/projects/[id]/route.ts).
          ...(completed !== undefined && {
            completedAt: completed ? new Date() : null,
            completedById: completed ? identity.userId : null,
          }),
          completionNotes: completionNotes ?? undefined,
          evidenceLevel: evidenceLevel ?? undefined,
        },
      });
    });

    if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(item);
  } catch (e) {
    return toResponse(e);
  }
}
