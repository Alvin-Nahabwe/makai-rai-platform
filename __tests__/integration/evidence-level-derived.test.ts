import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { testDb, resetDb, SEEDED_FRAMEWORK_VERSION_ID } from '../helpers/db';
import { sessionFor, clearSession } from '../helpers/authSession';

/**
 * Task 8 (Plan 1c), O-20 — the defect this whole plan cites as its
 * motivation. `RemediationItem.evidenceLevel` must become a value the
 * SERVER computes from whether real `evidence` rows exist for the item, and
 * the PATCH route must stop accepting it from a request body entirely.
 *
 * Both directions are proven, per the brief's own non-vacuity requirement —
 * a route that merely IGNORED the field and always returned a hardcoded
 * `self_attestation` would pass a test that checked only the first
 * direction below, without deriving anything at all:
 *
 *   1. A client-supplied `evidenceLevel: 'artifact_uploaded'` with NO real
 *      evidence attached must still read back `self_attestation`.
 *   2. Once real evidence is attached (through the production upload
 *      route, not a raw DB write), the SAME item must read back
 *      `artifact_uploaded` — with no client PATCH of `evidenceLevel`
 *      involved at all.
 *
 * Both assertions are checked through TWO independent read paths (the
 * PATCH response body AND a subsequent GET) — same shape as
 * remediation-patch.test.ts's "re-read from the database directly too, not
 * just the route's response" discipline, adapted here to "re-read through a
 * SECOND route handler, not just the one under test" (there is no
 * `artifactPath`-shaped raw-column fallback to catch, so a direct DB read
 * would only prove the column's stored value, not what every client-facing
 * surface actually serves — GET is the second real production caller).
 *
 * SESSION MOCKING / FIXTURES: identical seam to remediation-patch.test.ts
 * (`../helpers/authSession`) and identical evidence-upload shape to
 * evidence-upload.test.ts (`postEvidence`'s FormData/PNG-magic-bytes
 * pattern) — this file introduces no second fixture mechanism.
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

async function getRemediation(slug: string, assessmentId: string): Promise<Response> {
  const mod = await import('../../app/api/v1/orgs/[slug]/assessments/[id]/remediation/route');
  const req = new NextRequest('http://localhost/probe', { method: 'GET' });
  return mod.GET(req, { params: Promise.resolve({ slug, id: assessmentId }) });
}

// Magic-byte-only PNG fixture — the exact bytes evidence-upload.test.ts uses.
// inspect() only ever reads the leading bytes, so a full valid file is not required.
const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');

async function postEvidence(
  slug: string,
  assessmentId: string,
  remediationItemId: string,
): Promise<Response> {
  const mod = await import('../../app/api/v1/orgs/[slug]/assessments/[id]/evidence/route');
  const fd = new FormData();
  fd.set(
    'file',
    new File([new Uint8Array(PNG_BYTES)], 'evidence.png', { type: 'image/png' }),
  );
  fd.set('remediationItemId', remediationItemId);
  const req = new NextRequest('http://localhost/probe', { method: 'POST', body: fd });
  return mod.POST(req, { params: Promise.resolve({ slug, id: assessmentId }) });
}

async function seedItem() {
  const owner = await testDb.user.create({
    data: { email: 'evlvl-owner@fixture.test', name: 'Owner', passwordHash: 'x' },
  });
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
      mode: 'full',
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

describe('evidenceLevel is derived, not client-settable (O-20)', () => {
  beforeEach(() => {
    clearSession();
    return resetDb();
  });

  it('ignores a client-supplied evidenceLevel entirely — stays self_attestation with no evidence attached', async () => {
    const { owner, org, assessment, item } = await seedItem();
    sessionFor(owner.id);

    // Attacker/misbehaving-client claim: asserts artifact_uploaded with
    // nothing behind it. Same shape as the exact defect O-20 exists to close.
    const res = await patchRemediation(org.slug, assessment.id, {
      itemId: item.id,
      evidenceLevel: 'artifact_uploaded',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { evidenceLevel: string };
    expect(body.evidenceLevel).toBe('self_attestation');

    // Re-read through the SECOND production read path (GET), not just the
    // PATCH echo — proves the derivation is real, not an artifact of one
    // handler's response shaping.
    const getRes = await getRemediation(org.slug, assessment.id);
    expect(getRes.status).toBe(200);
    const items = (await getRes.json()) as Array<{ id: string; evidenceLevel: string }>;
    const found = items.find((i) => i.id === item.id);
    expect(found?.evidenceLevel).toBe('self_attestation');
  });

  it('reports artifact_uploaded once real evidence exists for the item, with no evidenceLevel PATCH involved', async () => {
    const { owner, org, assessment, item } = await seedItem();
    sessionFor(owner.id);

    // Real evidence, through the production upload route — not a raw DB
    // write and not a PATCH of evidenceLevel (none is sent at all here).
    const upload = await postEvidence(org.slug, assessment.id, item.id);
    expect(upload.status).toBe(201);

    const getRes = await getRemediation(org.slug, assessment.id);
    expect(getRes.status).toBe(200);
    const items = (await getRes.json()) as Array<{ id: string; evidenceLevel: string }>;
    const found = items.find((i) => i.id === item.id);
    expect(found?.evidenceLevel).toBe('artifact_uploaded');

    // And the PATCH response path agrees too (O-Consistency — every
    // client-facing read of this item must derive identically). A no-op
    // completionNotes PATCH, still with no evidenceLevel in the body.
    const patchRes = await patchRemediation(org.slug, assessment.id, {
      itemId: item.id,
      completionNotes: 'note unrelated to evidence',
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as { evidenceLevel: string };
    expect(patchBody.evidenceLevel).toBe('artifact_uploaded');
  });

  // The brief's own file list named only the remediation route, but O-20's
  // instruction — "wherever RemediationItem is returned to a client" — also
  // reaches these two, found by grepping every serializer of the model
  // (task-8-report.md carries the full enumeration). Covered here as their
  // own tests, not left to be incidentally proven by the two above, per
  // AGENTS.md §3's non-vacuity discipline: each proves a DIFFERENT claim
  // (this endpoint derives too), not a restatement of the first two.

  it('the assessment-detail GET route derives evidenceLevel too, not just the remediation route', async () => {
    const { owner, org, assessment, item } = await seedItem();
    sessionFor(owner.id);
    const upload = await postEvidence(org.slug, assessment.id, item.id);
    expect(upload.status).toBe(201);

    const mod = await import('../../app/api/v1/orgs/[slug]/assessments/[id]/route');
    const req = new NextRequest('http://localhost/probe', { method: 'GET' });
    const res = await mod.GET(req, { params: Promise.resolve({ slug: org.slug, id: assessment.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      remediationItems: Array<{ id: string; evidenceLevel: string }>;
    };
    const found = body.remediationItems.find((i) => i.id === item.id);
    expect(found?.evidenceLevel).toBe('artifact_uploaded');
  });

  it('the project-detail GET route derives evidenceLevel too, nested inside assessments', async () => {
    const { owner, org, project, assessment, item } = await seedItem();
    sessionFor(owner.id);
    const upload = await postEvidence(org.slug, assessment.id, item.id);
    expect(upload.status).toBe(201);

    const mod = await import('../../app/api/v1/orgs/[slug]/projects/[id]/route');
    const req = new NextRequest('http://localhost/probe', { method: 'GET' });
    const res = await mod.GET(req, { params: Promise.resolve({ slug: org.slug, id: project.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      assessments: Array<{ id: string; remediationItems: Array<{ id: string; evidenceLevel: string }> }>;
    };
    const foundAssessment = body.assessments.find((a) => a.id === assessment.id);
    const found = foundAssessment?.remediationItems.find((i) => i.id === item.id);
    expect(found?.evidenceLevel).toBe('artifact_uploaded');
  });
});
