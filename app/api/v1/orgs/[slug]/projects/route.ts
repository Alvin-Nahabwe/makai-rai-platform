import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContext, requireOrgContextWithIdentity } from '@/lib/auth/context';
import { NotFoundError, withOrg } from '@/lib/data/tenant';
import { lookupUserNames } from '@/lib/data/identity';
import { idempotentWrite, requestDigest } from '@/lib/data/idempotency';
import { readJsonBody } from '@/lib/http/jsonBody';
import { ValidationFailed } from '@/lib/http/errors';
import { toResponse } from '@/lib/http/toResponse';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { validateString, validateMetadataFields } from '@/lib/validate';
import { metadataColumnValues, validateProjectMetadataValues } from '@/lib/projects/metadataValues';

const ROUTE_POST = 'app/api/v1/orgs/[slug]/projects/route.ts::POST';

/**
 * Every org member may read every project in the org — ADR-0001's whole
 * rationale for deleting lib/authz.ts: "a colleague in the same org
 * legitimately reads a project they did not create". No `createdById`
 * filter, and no `orgId` filter — RLS scopes to the org under the GUC
 * `withOrg` sets; the absent `where` clause is the point (task brief).
 *
 * No `createdBy` relation `include` — `makrai_app` (the role `withOrg`
 * connects as) has no grant on `users` at all (see `lookupUserNames`'s
 * doc, lib/data/identity.ts). `createdById` is read as a plain scalar
 * column instead, and names are attached afterwards via `lookupUserNames`
 * on the identity connection.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const ctx = await requireOrgContext(slug, 'project:read');
    const projects = await withOrg(ctx, (tx) =>
      tx.project.findMany({
        include: {
          metadata: true,
          assessments: {
            select: {
              id: true,
              status: true,
              completedAt: true,
            },
            orderBy: { startedAt: 'desc' },
          },
        },
        orderBy: { updatedAt: 'desc' },
      }),
    );
    const names = await lookupUserNames(projects.map((p) => p.createdById));
    const withCreator = projects.map((p) => ({
      ...p,
      createdBy: names.get(p.createdById) ?? null,
    }));
    return NextResponse.json(withCreator);
  } catch (e) {
    return toResponse(e);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'project:create');

    const raw = await readJsonBody(req);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ValidationFailed([{ field: 'body', message: 'The request body must be a JSON object.' }]);
    }
    // `requestId` is not a project field: it is taken out before the key check, which refuses unknown keys.
    // Pull out the Project-level fields so only genuine ProjectMetadata fields remain in metadataFields:
    // otherwise `name` leaks into the nested ProjectMetadata.create (which has no `name`).
    const { requestId, name, description, aiSystemType, ...metadataFields } = raw as Record<string, unknown>;

    const nameResult = validateString(name, 'Project name', 200);
    if (nameResult.error) {
      return NextResponse.json({ error: nameResult.error.message }, { status: 400 });
    }
    const descResult = validateString(description, 'Description', 2000, false);
    if (descResult.error) {
      return NextResponse.json({ error: descResult.error.message }, { status: 400 });
    }
    // IMPORTANT-2 (final Plan 1b review): validate the metadata keys against the real `ProjectMetadata` schema
    // BEFORE they reach Prisma, shared with the PATCH route (lib/validate.ts) so the two cannot drift.
    const metadataResult = validateMetadataFields(metadataFields);
    if (metadataResult.error) {
      return NextResponse.json({ error: metadataResult.error.message }, { status: 400 });
    }
    const valueProblem = validateProjectMetadataValues({ ...metadataResult.value, ...(aiSystemType === undefined ? {} : { aiSystemType }) });
    if (valueProblem) {
      return NextResponse.json({ error: valueProblem.message }, { status: 400 });
    }

    // Owner answer A1: the create runs once per request id; a replay re-reads the project it made.
    const digest = requestDigest({ path: {}, body: raw });
    const outcome = await idempotentWrite(ctx, {
      table: 'request_receipts', route: ROUTE_POST, requestId: requestId as string, digest, actorUserId: identity.userId,
      write: (tx) =>
        // `orgId: ctx.orgId` is an INSERT value (NOT NULL, no default); the WITH CHECK policy verifies it matches the
        // GUC `withOrg` set. It is not a filter on a read (ADR-0001).
        tx.project.create({
          data: {
            orgId: ctx.orgId,
            name: nameResult.value,
            description: descResult.value || null,
            createdById: identity.userId,
            // No `orgId` here: nested under `project: { create }`, Prisma derives it from the composite FK.
            metadata: { create: { aiSystemType: (aiSystemType as string | undefined) || null, ...metadataColumnValues(metadataResult.value) } },
          },
          include: { metadata: true },
        }),
      receipt: (p) => ({ rowId: p.id }),
      replay: async (tx, receipt) => {
        const project = await tx.project.findUnique({ where: { id: receipt.rowId as string }, include: { metadata: true } });
        if (project === null) throw new NotFoundError();   // the project the first call made has since been deleted
        return project;
      },
    });

    return NextResponse.json(outcome.value, { status: outcome.replayed ? 200 : 201 });
  } catch (e) {
    return toResponse(e);
  }
}
