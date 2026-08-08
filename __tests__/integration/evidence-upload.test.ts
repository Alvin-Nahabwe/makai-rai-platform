import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { testDb, resetDb, SEEDED_FRAMEWORK_VERSION_ID } from '../helpers/db';
import { buildTwoOrgFixture, type TwoOrgFixture, type FixtureOrg } from '../helpers/fixture';
import { listEvidenceForAssessment } from '../../lib/data/evidence';
import { withOrg, type OrgContext } from '../../lib/data/tenant';
import { MAX_BYTES } from '../../lib/evidence/inspect';
import { POST, GET } from '../../app/api/v1/orgs/[slug]/assessments/[id]/evidence/route';

/**
 * Task 6. Covers the brief's Step 1 list (O-6, O-22, O-9, O-23, O-24, O-1)
 * PLUS the other three of the "five separate accept/reject decisions" the
 * task instructions name explicitly (identity, size-before-buffer,
 * inspect()-wiring) -- a single "upload works" test proves none of the
 * five, so each gets its own test below rather than being incidentally
 * exercised as a side effect of another one.
 *
 * FIXTURES: buildTwoOrgFixture() (brief constraint: "do not build a second
 * fixture mechanism") supplies users/orgs/roles only -- it creates no
 * Project (confirmed by reading fixture.ts directly, not from memory: Task
 * 2's implementer found the same thing). Project/Assessment/RemediationItem
 * are built directly via `testDb`, the same convention every other
 * integration file in this suite uses for its own domain resources
 * (evidence-schema.test.ts, permission-matrix.test.ts's buildOrgResources).
 *
 * SESSION MOCKING: identical seam and shape to permission-matrix.test.ts --
 * `requireIdentityForApi` dynamically imports `../auth` and calls its
 * `auth()` export; that is the one mockable seam without a real cookie jar.
 */

let currentSession: { user: { id: string }; sessionEpoch: number; sessionIssuedAt: number } | null = null;

vi.mock('../../lib/auth', () => ({
  auth: () => Promise.resolve(currentSession),
}));

function sessionFor(userId: string): void {
  currentSession = { user: { id: userId }, sessionEpoch: 0, sessionIssuedAt: Math.floor(Date.now() / 1000) };
}

// Magic-byte-only fixtures, same minimal shape __tests__/unit/evidence-inspect.test.ts
// uses -- inspect() only ever reads the leading bytes, so a full valid file
// is not required to exercise it.
const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');
const PDF_BYTES = Buffer.from('255044462d312e34', 'hex'); // %PDF-1.4
const HTML_BYTES = Buffer.from('<html><script>alert(1)</script>');

function evidenceFormData(opts: {
  content?: Buffer;
  filename?: string;
  clientDeclaredType?: string;
  questionId?: string;
  remediationItemId?: string;
}): FormData {
  const fd = new FormData();
  const content = opts.content ?? PNG_BYTES;
  fd.set(
    'file',
    // new Uint8Array(content) copies into a fresh, non-shared ArrayBuffer --
    // Buffer's declared type (Buffer<ArrayBufferLike>) is wider than
    // BlobPart's (Uint8Array<ArrayBuffer>) and TypeScript rejects the Buffer
    // literal directly.
    new File([new Uint8Array(content)], opts.filename ?? 'evidence.png', {
      type: opts.clientDeclaredType ?? 'image/png',
    }),
  );
  if (opts.questionId !== undefined) fd.set('questionId', opts.questionId);
  if (opts.remediationItemId !== undefined) fd.set('remediationItemId', opts.remediationItemId);
  return fd;
}

async function postEvidence(
  slug: string,
  assessmentId: string,
  formOrHeaders: FormData | { contentLength: number } | { rawContentLength: string },
): Promise<Response> {
  const req =
    formOrHeaders instanceof FormData
      ? new NextRequest('http://localhost/probe', { method: 'POST', body: formOrHeaders })
      : new NextRequest('http://localhost/probe', {
          method: 'POST',
          headers: {
            'content-length':
              'contentLength' in formOrHeaders ? String(formOrHeaders.contentLength) : formOrHeaders.rawContentLength,
          },
        });
  return POST(req, { params: Promise.resolve({ slug, id: assessmentId }) });
}

function getEvidence(slug: string, assessmentId: string): Promise<Response> {
  const req = new NextRequest('http://localhost/probe', { method: 'GET' });
  return GET(req, { params: Promise.resolve({ slug, id: assessmentId }) });
}

function ctxFor(orgId: string): OrgContext {
  // Same documented escape hatch every integration test uses (fixture.ts's
  // own `ownerContext`, tenant-layer.test.ts's `ctx()`) -- OrgContext is
  // branded specifically to stop ACCIDENTAL construction; a deliberate `as`
  // cast in a test is the established, sanctioned exception.
  return { orgId, role: 'owner' } as OrgContext;
}

describe('evidence upload route', () => {
  let fixture: TwoOrgFixture;
  let orgA: FixtureOrg;
  let orgB: FixtureOrg;
  let ownerA: string;

  // Org A: two in-progress assessments (main + other, for O-6) and one
  // completed assessment (O-24). Org B: one in-progress assessment, used
  // only to seed cross-org evidence for O-1.
  let assessmentMainId: string;
  let assessmentOtherId: string;
  let assessmentCompletedId: string;
  let remediationOnOtherId: string; // belongs to assessmentOtherId, NOT assessmentMainId
  let orgBAssessmentId: string;

  beforeAll(async () => {
    await resetDb();
    fixture = await buildTwoOrgFixture();
    [orgA, orgB] = fixture.orgs;
    const owner = fixture.users.find((u) => u.orgSlug === orgA.slug && u.role === 'owner' && u.index === 0);
    if (!owner) throw new Error('fixture must carry a bootstrap owner for org A');
    ownerA = owner.userId;

    const projectA = await testDb.project.create({
      data: { orgId: orgA.id, name: 'Evidence probe project A', createdById: ownerA },
    });

    const [main, other, completed] = await Promise.all([
      testDb.assessment.create({
        data: {
          orgId: orgA.id,
          projectId: projectA.id,
          userId: ownerA,
          mode: 'full',
          frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
          engineState: {},
        },
      }),
      testDb.assessment.create({
        data: {
          orgId: orgA.id,
          projectId: projectA.id,
          userId: ownerA,
          mode: 'full',
          frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
          engineState: {},
        },
      }),
      testDb.assessment.create({
        data: {
          orgId: orgA.id,
          projectId: projectA.id,
          userId: ownerA,
          mode: 'full',
          frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
          engineState: {},
          status: 'completed',
          completedAt: new Date(),
        },
      }),
    ]);
    assessmentMainId = main.id;
    assessmentOtherId = other.id;
    assessmentCompletedId = completed.id;

    const remediationOnOther = await testDb.remediationItem.create({
      data: {
        orgId: orgA.id,
        assessmentId: assessmentOtherId,
        areaId: 'PO-03',
        areaName: 'Accountability',
        tier: 'gap',
        description: 'Belongs to assessmentOther, not assessmentMain -- the O-6 negative target',
      },
    });
    remediationOnOtherId = remediationOnOther.id;

    // Org B: a project + assessment, plus a real evidence row seeded
    // directly (this is ARRANGEMENT, not the assertion -- the O-1 test
    // below asserts through withOrg + listEvidenceForAssessment, not raw SQL).
    const ownerB = fixture.users.find((u) => u.orgSlug === orgB.slug && u.role === 'owner' && u.index === 0);
    if (!ownerB) throw new Error('fixture must carry a bootstrap owner for org B');
    const projectB = await testDb.project.create({
      data: { orgId: orgB.id, name: 'Evidence probe project B', createdById: ownerB.userId },
    });
    const assessmentB = await testDb.assessment.create({
      data: {
        orgId: orgB.id,
        projectId: projectB.id,
        userId: ownerB.userId,
        mode: 'full',
        frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
        engineState: {},
      },
    });
    orgBAssessmentId = assessmentB.id;
    await testDb.evidence.create({
      data: {
        orgId: orgB.id,
        assessmentId: orgBAssessmentId,
        frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
        questionId: 'Q-ORG-B-ONLY',
        filename: 'org-b-only.pdf',
        mimeType: 'application/pdf',
        byteSize: 4,
        sha256: 'org-b-seed-hash',
        uploadedById: ownerB.userId,
      },
    });
  });

  // ---- Check 1: identity ---------------------------------------------

  it('rejects an unauthenticated request (401) -- proves the route actually calls requireOrgContextWithIdentity', async () => {
    currentSession = null;
    const res = await postEvidence(orgA.slug, assessmentMainId, evidenceFormData({ questionId: 'Q-PP-01' }));
    expect(res.status).toBe(401);
  });

  // ---- Check 2: size gate before buffering ---------------------------

  it('rejects a request whose declared Content-Length exceeds MAX_BYTES (400) -- the pre-buffer size gate', async () => {
    sessionFor(ownerA);
    const res = await postEvidence(orgA.slug, assessmentMainId, { contentLength: MAX_BYTES + 1 });
    expect(res.status).toBe(400);
    // Message, not just status -- see the non-numeric test below for why
    // status alone is not sufficient proof this specific gate fired.
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('File too large');
  });

  it('rejects a non-numeric Content-Length (400, from the SIZE GATE specifically) -- silent-failure-hunter finding: Number("abc") > MAX_BYTES is NaN > MAX_BYTES, which is false, so this must NOT silently pass the gate', async () => {
    sessionFor(ownerA);
    const res = await postEvidence(orgA.slug, assessmentMainId, { rawContentLength: 'abc' });
    expect(res.status).toBe(400);
    // Asserting the STATUS alone would be vacuous here: a request with a
    // garbage Content-Length and no real multipart body also fails
    // req.formData() itself, which is caught SEPARATELY and returns 400
    // with a DIFFERENT message -- that catch firing would mask a broken
    // size gate. Asserting the size gate's specific message is what proves
    // THIS check, not some other one, produced the rejection.
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('File too large');
  });

  it('rejects a negative Content-Length (400, from the SIZE GATE specifically) -- same fail-closed requirement as the non-numeric case', async () => {
    sessionFor(ownerA);
    const res = await postEvidence(orgA.slug, assessmentMainId, { rawContentLength: '-5' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('File too large');
  });

  // ---- Check 3: inspect() wiring -- client's declared type discarded --

  it("discards the client's declared MIME type and stores what inspect() actually determined from the bytes", async () => {
    sessionFor(ownerA);
    // Client declares image/png; the bytes are actually a PDF signature.
    const res = await postEvidence(
      orgA.slug,
      assessmentMainId,
      evidenceFormData({ content: PDF_BYTES, clientDeclaredType: 'image/png', questionId: 'Q-PP-03' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mimeType: string };
    expect(body.mimeType).toBe('application/pdf'); // NOT 'image/png' -- the client's claim
  });

  it('rejects bytes matching no known signature, regardless of the declared type (400, reason surfaced)', async () => {
    sessionFor(ownerA);
    const res = await postEvidence(
      orgA.slug,
      assessmentMainId,
      evidenceFormData({ content: HTML_BYTES, clientDeclaredType: 'image/png', questionId: 'Q-PP-04' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unrecognised/i);
  });

  // ---- O-6: attach-target confinement WITHIN the org -------------------

  it('rejects a remediationItemId belonging to a different assessment in the same org (O-6)', async () => {
    sessionFor(ownerA);
    // remediationOnOtherId belongs to assessmentOtherId, but the URL names
    // assessmentMainId. RLS alone would accept this (same org); O-6 is the
    // additional, WITHIN-org check that must reject it.
    const res = await postEvidence(
      orgA.slug,
      assessmentMainId,
      evidenceFormData({ remediationItemId: remediationOnOtherId }),
    );
    expect(res.status).toBe(404);
  });

  // ---- O-22: questionId must exist in the pinned version's question bank --

  it('rejects a questionId that does not exist in the pinned framework version (O-22)', async () => {
    sessionFor(ownerA);
    const res = await postEvidence(
      orgA.slug,
      assessmentMainId,
      evidenceFormData({ questionId: 'Q-DOES-NOT-EXIST-ANYWHERE' }),
    );
    expect(res.status).toBe(400);
  });

  // ---- O-9: attribution and integrity ----------------------------------

  it('records uploadedById, byteSize and the sha256 of the stored bytes (O-9)', async () => {
    sessionFor(ownerA);
    const res = await postEvidence(orgA.slug, assessmentMainId, evidenceFormData({ questionId: 'Q-PP-05' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      uploadedById: string;
      byteSize: number;
      sha256: string;
    };
    expect(body.uploadedById).toBe(ownerA);
    expect(body.byteSize).toBe(PNG_BYTES.length);
    expect(body.sha256).toBe(createHash('sha256').update(PNG_BYTES).digest('hex'));
  });

  // ---- O-23: idempotent retry, not duplication -------------------------

  it('returns the existing row when the same bytes are uploaded to the same claim twice (O-23)', async () => {
    sessionFor(ownerA);
    const first = await postEvidence(orgA.slug, assessmentMainId, evidenceFormData({ questionId: 'Q-PP-06' }));
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string };

    const second = await postEvidence(orgA.slug, assessmentMainId, evidenceFormData({ questionId: 'Q-PP-06' }));
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { id: string };

    expect(secondBody.id).toBe(firstBody.id);

    const rows = await testDb.evidence.findMany({
      where: { assessmentId: assessmentMainId, questionId: 'Q-PP-06' },
    });
    expect(rows).toHaveLength(1);
  });

  // ---- O-24: a completed assessment accepts no new evidence ------------

  it('rejects an upload to a completed assessment (O-24, 409)', async () => {
    sessionFor(ownerA);
    const res = await postEvidence(
      orgA.slug,
      assessmentCompletedId,
      evidenceFormData({ questionId: 'Q-PP-07' }),
    );
    expect(res.status).toBe(409);
  });

  // ---- O-1: cross-org isolation, through withOrg, not raw SQL ----------

  it('does not return org B evidence to an org A context (O-1)', async () => {
    // Assert through the PRODUCTION data-access path (withOrg + the data
    // layer this task builds), not a hand-filtered SELECT -- a raw-SQL
    // assertion would prove the query text was right, not that RLS
    // actually enforced anything.
    const seenFromOrgA = await withOrg(ctxFor(orgA.id), (tx) => listEvidenceForAssessment(orgBAssessmentId, tx));
    expect(seenFromOrgA).toEqual([]);

    // Sanity check on the SAME assessment id, from org B's own context, to
    // prove the query itself is not simply broken (an assessmentId that
    // matches nothing would ALSO return [] and prove nothing about isolation).
    const seenFromOrgB = await withOrg(ctxFor(orgB.id), (tx) => listEvidenceForAssessment(orgBAssessmentId, tx));
    expect(seenFromOrgB).toHaveLength(1);
    expect(seenFromOrgB[0]?.questionId).toBe('Q-ORG-B-ONLY');
  });

  // ---- GET: the read side of evidence:read (needed for O-17's ROUTE_ACTIONS
  // declaration to be backed by a real handler, not a brief gap -- see
  // task-6-report.md) --------------------------------------------------

  it('GET lists evidence for the named assessment, metadata only', async () => {
    sessionFor(ownerA);
    const upload = await postEvidence(orgA.slug, assessmentMainId, evidenceFormData({ questionId: 'Q-PP-08' }));
    expect(upload.status).toBe(201);

    const res = await getEvidence(orgA.slug, assessmentMainId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ questionId: string | null; content?: unknown }>;
    expect(body.some((e) => e.questionId === 'Q-PP-08')).toBe(true);
    expect(body.every((e) => e.content === undefined)).toBe(true); // never the bytes
  });
});
