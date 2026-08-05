import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContext, requireOrgContextWithIdentity } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { lookupUserNames } from '@/lib/data/identity';
import { toResponse } from '@/lib/http/toResponse';
import { validateString, validateMetadataFields } from '@/lib/validate';

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
            select: { id: true, status: true, overallScore: true, completedAt: true, mode: true },
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
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'project:create');

    const body = await req.json();
    // Pull out the Project-level fields so only genuine ProjectMetadata
    // fields remain in metadataFields — otherwise `name` leaks into the
    // nested ProjectMetadata.create (which has no `name`) and Prisma
    // rejects it.
    const { name, description, aiSystemType, ...metadataFields } = body;

    const nameResult = validateString(name, 'Project name', 200);
    if (nameResult.error) {
      return NextResponse.json({ error: nameResult.error.message }, { status: 400 });
    }
    const descResult = validateString(description, 'Description', 2000, false);
    if (descResult.error) {
      return NextResponse.json({ error: descResult.error.message }, { status: 400 });
    }
    // IMPORTANT-2 (final Plan 1b review): validate the metadata keys
    // against the real `ProjectMetadata` schema BEFORE they reach Prisma —
    // shared with the PATCH route (lib/validate.ts) so the two cannot drift
    // the way they already had once (PATCH validated nothing at all).
    const metadataResult = validateMetadataFields(metadataFields);
    if (metadataResult.error) {
      return NextResponse.json({ error: metadataResult.error.message }, { status: 400 });
    }

    const project = await withOrg(ctx, (tx) =>
      // `orgId: ctx.orgId` here is NOT the "app filter that masks RLS"
      // pattern the brief warns against — that warning is about `where`
      // clauses on READS, which would duplicate RLS's USING clause. This is
      // an INSERT: `orgId` is a NOT NULL column with no default, so Postgres
      // requires a literal value regardless of RLS, and the `WITH CHECK`
      // policy then VERIFIES that value matches the GUC `withOrg` set — a
      // check on the value being written, not a second filter on what comes
      // back (ADR-0001, Task 0 spike: "WITH CHECK on writes").
      tx.project.create({
        data: {
          orgId: ctx.orgId,
          name: nameResult.value,
          description: descResult.value || null,
          createdById: identity.userId,
          metadata: {
            // No `orgId` here — nested under `project: { create: ... }`,
            // Prisma derives it from the parent (the composite FK
            // `[orgId, projectId] -> [orgId, id]` on ProjectMetadata), and
            // its generated type for this nested form excludes the field
            // for exactly that reason.
            create: {
              aiSystemType: aiSystemType || null,
              ...metadataResult.value,
            },
          },
        },
        include: { metadata: true },
      }),
    );

    return NextResponse.json(project, { status: 201 });
  } catch (e) {
    return toResponse(e);
  }
}
