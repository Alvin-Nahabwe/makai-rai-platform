import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { testDb, resetDb, SEEDED_FRAMEWORK_VERSION_ID } from '../helpers/db';
import { sessionFor, clearSession } from '../helpers/authSession';

/**
 * IMPORTANT-1 (final Plan 1b whole-branch review, fix wave 2026-08-05):
 * `app/api/v1/orgs/[slug]/assessments/[id]/remediation/route.ts` PATCH wrote
 * `completedAt`/`completedById` UNCONDITIONALLY (`completed ? new Date() :
 * null` / `completed ? identity.userId : null`), while `completed` itself was
 * correctly left alone when absent (`completed ?? undefined`). A PATCH that
 * sends only `completionNotes` or `evidenceLevel` — `completed` therefore
 * `undefined`, which is falsy — nulled out WHO completed the item and WHEN,
 * on an item that stayed `completed: true`. For an ISO-42001 evidence trail
 * that is silent corruption of the product's core artifact.
 *
 * Same seam `permission-matrix.test.ts` uses, factored into
 * `../helpers/authSession` at this fix wave's simplify pass: `requireIdentityForApi`
 * dynamically imports `../auth` (lib/auth.ts) and calls its `auth()` export,
 * so mocking that module is the only seam needed to drive the REAL route
 * handler with a REAL session, real Prisma, real RLS, real `withOrg`.
 */

async function patchRemediation(
  slug: string,
  assessmentId: string,
  body: unknown,
): Promise<Response> {
  const mod = await import('../../app/api/v1/orgs/[slug]/assessments/[id]/remediation/route');
  const req = new NextRequest('http://localhost/probe', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return mod.PATCH(req, { params: Promise.resolve({ slug, id: assessmentId }) });
}

describe('PATCH .../remediation — completion provenance survives a partial update', () => {
  beforeEach(() => {
    clearSession();
    return resetDb();
  });

  it('leaves completedAt/completedById alone when the PATCH omits `completed`', async () => {
    const owner = await testDb.user.create({
      data: { email: 'rem-prov-owner@fixture.test', name: 'Owner', passwordHash: 'x' },
    });
    const org = await testDb.organization.create({ data: { name: 'rem-prov-org', slug: 'rem-prov-org' } });
    await testDb.membership.create({ data: { orgId: org.id, userId: owner.id, role: 'owner' } });
    const project = await testDb.project.create({
      data: { orgId: org.id, name: 'Provenance probe project', createdById: owner.id },
    });
    const assessment = await testDb.assessment.create({
      data: {
        orgId: org.id,
        projectId: project.id,
        userId: owner.id,
        mode: 'quick',
        frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
        engineState: {},
      },
    });
    const originalCompletedAt = new Date('2026-01-01T00:00:00Z');
    const item = await testDb.remediationItem.create({
      data: {
        orgId: org.id,
        assessmentId: assessment.id,
        areaId: 'area-1',
        areaName: 'Area 1',
        tier: 'gap',
        description: 'desc',
        completed: true,
        completedAt: originalCompletedAt,
        completedById: owner.id,
      },
    });

    sessionFor(owner.id);
    // PATCH sends ONLY completionNotes — `completed` is absent from the body.
    const res = await patchRemediation(org.slug, assessment.id, {
      itemId: item.id,
      completionNotes: 'a later note, added after the item was already marked done',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.completed).toBe(true);
    expect(body.completedAt).not.toBeNull();
    expect(new Date(body.completedAt).getTime()).toBe(originalCompletedAt.getTime());
    expect(body.completedById).toBe(owner.id);
    expect(body.completionNotes).toBe('a later note, added after the item was already marked done');

    // Re-read from the database directly too — not just the route's response.
    const stored = await testDb.remediationItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stored.completed).toBe(true);
    expect(stored.completedAt?.getTime()).toBe(originalCompletedAt.getTime());
    expect(stored.completedById).toBe(owner.id);
  });
});
