import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContext, requireOrgContextWithIdentity } from '@/lib/auth/context';
import { NotFoundError, withOrg } from '@/lib/data/tenant';
import { lookupUserNames } from '@/lib/data/identity';
import { idempotentWrite, requestDigest } from '@/lib/data/idempotency';
import { assertProjectWritable } from '@/lib/data/projectGuard';
import { readJsonBody } from '@/lib/http/jsonBody';
import { asJsonObject, assertRequestId, parseRequestIdBody } from '@/lib/http/requestIdBody';
import { projectHasRecords } from '@/lib/data/projects';
import { ConflictError, ValidationFailed } from '@/lib/http/errors';
import { toResponse } from '@/lib/http/toResponse';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { validateString, validateMetadataFields, requireNonBlank } from '@/lib/validate';
import { metadataColumnValues, validateProjectMetadataValues } from '@/lib/projects/metadataValues';

const ROUTE_PATCH = 'app/api/v1/orgs/[slug]/projects/[id]/route.ts::PATCH';
const ROUTE_DELETE = 'app/api/v1/orgs/[slug]/projects/[id]/route.ts::DELETE';

/**
 * No `user`/`createdBy` relation `include` anywhere below — `makrai_app`
 * has no grant on `users` (see lib/data/identity.ts#lookupUserNames).
 * Scalar `userId`/`createdById` columns are read directly off the tenant
 * rows and names are attached afterwards via `lookupUserNames`.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    const ctx = await requireOrgContext(slug, 'project:read');
    const project = await withOrg(ctx, (tx) => tx.project.findUnique({ where: { id }, include: { metadata: true } }));
    // RLS scopes `id` to this org; a project belonging to another org or one that never existed is
    // INDISTINGUISHABLE here: both come back null.
    if (!project) return toResponse(new NotFoundError());

    const names = await lookupUserNames([project.createdById]);
    return NextResponse.json({ ...project, createdBy: names.get(project.createdById) ?? null });
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
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'project:update');
    const raw = asJsonObject(await readJsonBody(req));
    // `requestId` is not a project field: it is taken out before the key check, which refuses unknown keys.
    const { requestId, name, description, ...metadataFields } = raw;

    // IMPORTANT-2 (final Plan 1b review): the same validation POST uses (lib/validate.ts), applied only when the
    // field is actually present in the body; PATCH still permits omitting `name` or `description`. Every refusal is a
    // 422 `validation` naming the form's own field.
    let nameValue: string | undefined;
    if (name !== undefined) {
      const nameResult = validateString(name, 'Project name', 200);
      const nameError = requireNonBlank(nameResult, 'Project name');
      if (nameError) throw new ValidationFailed([{ field: 'name', message: nameError.message }]);
      nameValue = nameResult.value;
    }

    let descriptionValue: string | undefined;
    if (description !== undefined) {
      const descResult = validateString(description, 'Description', 2000, false);
      if (descResult.error) throw new ValidationFailed([{ field: 'description', message: descResult.error.message }]);
      descriptionValue = descResult.value;
    }

    const metadataResult = validateMetadataFields(metadataFields);
    if (metadataResult.error) throw new ValidationFailed([{ field: metadataResult.error.field, message: metadataResult.error.message }]);
    const valueProblem = validateProjectMetadataValues(metadataResult.value);
    if (valueProblem) throw new ValidationFailed([valueProblem]);
    assertRequestId(raw);   // before the digest, which throws on a number (F4)

    // Owner answer A1: the edit runs once per request id; a replay re-reads the project and writes nothing.
    // A project in another organisation is not visible under RLS: assertProjectWritable answers it 404.
    const columns = metadataColumnValues(metadataResult.value);
    const digest = requestDigest({ path: { id }, body: raw });
    const outcome = await idempotentWrite(ctx, {
      table: 'request_receipts', route: ROUTE_PATCH, requestId: requestId as string, digest, actorUserId: identity.userId,
      write: async (tx) => {
        await assertProjectWritable(tx, id);
        return tx.project.update({
          where: { id },
          data: {
            ...(nameValue !== undefined && { name: nameValue }),
            ...(description !== undefined && { description: descriptionValue || null }),
            metadata: { upsert: { create: columns, update: columns } },
          },
          include: { metadata: true },
        });
      },
      receipt: () => ({ rowId: null }),
      replay: async (tx) => {
        const project = await tx.project.findUnique({ where: { id }, include: { metadata: true } });
        if (project === null) throw new NotFoundError();
        return project;
      },
    });
    return NextResponse.json(outcome.value);
  } catch (e) {
    return toResponse(e);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'project:delete');
    const body = parseRequestIdBody(await readJsonBody(req));
    // Owner answer A1: a project that holds a record is refused (409, which rolls the receipt back with it); a replay
    // of a finished delete finds its receipt first and answers 200 again.
    const digest = requestDigest({ path: { id }, body });
    await idempotentWrite(ctx, {
      table: 'request_receipts', route: ROUTE_DELETE, requestId: body.requestId, digest, actorUserId: identity.userId,
      write: async (tx) => {
        // Lock the row first. Every record write reads it FOR SHARE (assertProjectWritable) and holds that to its
        // commit, so this waits for a write in flight, and the emptiness check below sees the rows it committed.
        // A write that starts after this lock waits for the delete and finds no project.
        const locked = await tx.$queryRaw<{ archivedAt: Date | null }[]>`SELECT "archivedAt" FROM "projects" WHERE "id" = ${id} FOR UPDATE`;
        if (locked.length === 0) throw new NotFoundError();
        if (locked[0].archivedAt !== null) throw new ConflictError('project_archived');   // an archived project is read-only (FR-PRJ-03)
        if (await projectHasRecords(tx, id)) throw new ConflictError('project_has_records');
        await tx.project.delete({ where: { id } });
      },
      receipt: () => ({ rowId: null }),
      replay: async () => undefined,
    });
    return NextResponse.json({ success: true });
  } catch (e) {
    return toResponse(e);
  }
}
