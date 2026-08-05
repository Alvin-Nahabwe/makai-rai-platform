import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { testDb, resetDb } from '../helpers/db';
import { sessionFor, clearSession } from '../helpers/authSession';

/**
 * IMPORTANT-2 (final Plan 1b whole-branch review, fix wave 2026-08-05):
 * `app/api/v1/orgs/[slug]/projects/route.ts` POST validates `name` (max 200)
 * and `description` (max 2000) via `validateString`. `.../projects/[id]/
 * route.ts` PATCH validated NEITHER — `...(name && { name })` accepted an
 * unbounded string, and raw `metadataFields` reached `metadata.upsert`
 * unfiltered, so a stray body key not in the `ProjectMetadata` schema
 * produced a Prisma "Unknown argument" 500 where 400 belongs. Any member
 * with `project:update` could therefore write data POST would have
 * rejected. This suite proves the PATCH route now applies the SAME
 * validation POST does, and that an unknown body key 400s instead of 500ing.
 *
 * Same session-mocking seam as permission-matrix.test.ts /
 * remediation-patch.test.ts, factored into `../helpers/authSession` at
 * this fix wave's simplify pass.
 */

async function patchProject(slug: string, id: string, body: unknown): Promise<Response> {
  const mod = await import('../../app/api/v1/orgs/[slug]/projects/[id]/route');
  const req = new NextRequest('http://localhost/probe', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return mod.PATCH(req, { params: Promise.resolve({ slug, id }) });
}

describe('PATCH .../projects/[id] — validation symmetry with POST', () => {
  beforeEach(() => {
    clearSession();
    return resetDb();
  });

  async function seed() {
    const owner = await testDb.user.create({
      data: { email: 'proj-patch-owner@fixture.test', name: 'Owner', passwordHash: 'x' },
    });
    const org = await testDb.organization.create({ data: { name: 'proj-patch-org', slug: 'proj-patch-org' } });
    await testDb.membership.create({ data: { orgId: org.id, userId: owner.id, role: 'owner' } });
    const project = await testDb.project.create({
      data: { orgId: org.id, name: 'Original name', createdById: owner.id },
    });
    sessionFor(owner.id);
    return { owner, org, project };
  }

  it('rejects a name over 200 characters with 400, same as POST would', async () => {
    const { org, project } = await seed();
    const res = await patchProject(org.slug, project.id, { name: 'x'.repeat(201) });
    expect(res.status).toBe(400);

    const stored = await testDb.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stored.name).toBe('Original name'); // rejected write never lands
  });

  it('rejects a description over 2000 characters with 400', async () => {
    const { org, project } = await seed();
    const res = await patchProject(org.slug, project.id, { description: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
  });

  it('400s on an unknown body key instead of a Prisma 500', async () => {
    const { org, project } = await seed();
    const res = await patchProject(org.slug, project.id, { notARealField: 'whatever' });
    expect(res.status).toBe(400);
  });

  it('accepts a PATCH that sets aiSystemType — a real ProjectMetadata column POST also accepts', async () => {
    // Self-review catch: `aiSystemType` is a legitimate `ProjectMetadata`
    // column (prisma/schema.prisma) and POST accepts it, but POST's route
    // destructures it OUT of `metadataFields` before validating, while
    // PATCH does not — so it must be a member of the shared allowlist
    // (lib/validate.ts's PROJECT_METADATA_FIELDS) or every PATCH setting it
    // would wrongly 400 as an "unknown field".
    const { org, project } = await seed();
    const res = await patchProject(org.slug, project.id, { aiSystemType: 'computer_vision' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metadata.aiSystemType).toBe('computer_vision');
  });

  it('still accepts a valid name/description update', async () => {
    const { org, project } = await seed();
    const res = await patchProject(org.slug, project.id, {
      name: 'Updated name',
      description: 'Updated description',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Updated name');
    expect(body.description).toBe('Updated description');
  });
});
