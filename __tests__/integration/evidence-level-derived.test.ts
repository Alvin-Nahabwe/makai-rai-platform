import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { testDb, resetDb, SEEDED_FRAMEWORK_VERSION_ID } from '../helpers/db';
import { stubAcceptanceRows } from '../helpers/legalStub';
import { sessionFor, clearSession } from '../helpers/authSession';

/**
 * Task 8 (Plan 1c), O-20 -- `RemediationItem.evidenceLevel` is a value the
 * SERVER computes from whether real `evidence` rows exist for the item, never
 * a value a client sets.
 *
 * Only the project-detail half survives the score removal (RM): the
 * remediation, assessment-detail and upload routes this file used to drive
 * are deleted, and `__tests__/lint/removed-score-routes.test.ts` pins that.
 * `GET .../projects/[id]` still serialises assessments with their
 * remediation items, so it still has to derive the level. The evidence row
 * that used to arrive through the upload route is now written directly with
 * `testDb`, the same convention every other fixture row here follows.
 */

async function seedItem() {
  const owner = await testDb.user.create({
    data: { email: 'evlvl-owner@fixture.test', name: 'Owner', passwordHash: 'x' },
  });
  await testDb.consentRecord.createMany({ data: stubAcceptanceRows(owner.id) });
  const org = await testDb.organization.create({ data: { name: 'evlvl-org', slug: 'evlvl-org' } });
  await testDb.membership.create({ data: { orgId: org.id, userId: owner.id, role: 'owner' } });
  const project = await testDb.project.create({
    data: { orgId: org.id, name: 'evlvl project', createdById: owner.id },
  });
  const assessment = await testDb.assessment.create({
    data: {
      orgId: org.id,
      projectId: project.id,
      userId: owner.id,
      frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
      engineState: {},
    },
  });
  const item = await testDb.remediationItem.create({
    data: {
      orgId: org.id,
      assessmentId: assessment.id,
      areaId: 'PO-03',
      areaName: 'Accountability',
      tier: 'gap',
      description: 'evlvl probe item',
    },
  });
  return { owner, org, project, assessment, item };
}

async function getProject(slug: string, id: string) {
  const mod = await import('../../app/api/v1/orgs/[slug]/projects/[id]/route');
  const req = new NextRequest('http://localhost/probe', { method: 'GET' });
  const res = await mod.GET(req, { params: Promise.resolve({ slug, id }) });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    assessments: Array<{ id: string; remediationItems: Array<{ id: string; evidenceLevel: string }> }>;
  };
}

describe('evidenceLevel is derived, not client-settable (O-20)', () => {
  beforeEach(() => {
    clearSession();
    return resetDb();
  });

  it('the project-detail GET route derives evidenceLevel, nested inside assessments, from real evidence rows', async () => {
    const { owner, org, project, assessment, item } = await seedItem();
    sessionFor(owner.id);

    // Non-vacuity, both directions: with nothing attached the level reads
    // self_attestation, so a route that always returned artifact_uploaded
    // (or never derived anything) cannot pass the second read.
    const before = await getProject(org.slug, project.id);
    const beforeItem = before.assessments
      .find((a) => a.id === assessment.id)
      ?.remediationItems.find((i) => i.id === item.id);
    expect(beforeItem?.evidenceLevel).toBe('self_attestation');

    const content = Buffer.from('evlvl probe evidence');
    await testDb.evidence.create({
      data: {
        orgId: org.id,
        assessmentId: assessment.id,
        remediationItemId: item.id,
        frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
        filename: 'evlvl-probe.pdf',
        mimeType: 'application/pdf',
        byteSize: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    });

    const after = await getProject(org.slug, project.id);
    const afterItem = after.assessments
      .find((a) => a.id === assessment.id)
      ?.remediationItems.find((i) => i.id === item.id);
    expect(afterItem?.evidenceLevel).toBe('artifact_uploaded');
  });
});
