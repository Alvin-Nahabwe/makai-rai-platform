import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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

  // Org A: two in-progress assessments (main + other, for O-6), one
  // completed assessment (O-24), and one pinned to a deliberately-wrong
  // framework_versions row (O-14 drift, fix round 1). Org B: one
  // in-progress assessment, used to seed cross-org evidence for O-1, plus
  // one remediation item, used for the O-6/O-1 converse test (fix round 1,
  // Minor 2).
  let assessmentMainId: string;
  let assessmentOtherId: string;
  let assessmentCompletedId: string;
  let assessmentDriftedId: string;
  // Fix round 2, Important 1: BOTH completed AND drifted -- the state
  // respondToAssessment's own fix-round-1 comment argues 'completed' must
  // win for (the sibling PATCH route checks 'completed' before drift,
  // deliberately). This route checked them the OTHER way; this fixture
  // proves the reordering rather than merely asserting it.
  let assessmentCompletedDriftedId: string;
  let remediationOnOtherId: string; // belongs to assessmentOtherId, NOT assessmentMainId
  let remediationOnOrgBId: string; // belongs to org B entirely
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

    // O-14 drift fixture (fix round 1, Important 1), same pattern
    // framework-hash.test.ts's own "reports a mismatch" test uses -- a
    // second framework_versions row with a deliberately wrong contentHash,
    // since the migration's own seeded row is correct by construction and
    // is the only way to make resolveFramework(...).matches false. A
    // DISTINCT id/semver from framework-hash.test.ts's own 'fv_bogus'/'9.9.9'
    // (not reused) so the two files share no fixture state to accidentally
    // collide on. framework_versions carries no RLS (Task 1), so this is
    // written on the identity connection like the migration's own row.
    await testDb.$executeRaw`
      INSERT INTO "framework_versions" ("id","semver","contentHash","publishedAt")
      VALUES ('fv_bogus_task6','9.9.9-task6','0000000000000000000000000000000000000000000000000000000000000000', now())
      ON CONFLICT ("id") DO NOTHING`;

    const [main, other, completed, drifted, completedDrifted] = await Promise.all([
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
      // Pinned to the bogus row above, NOT the real seeded version --
      // resolveFramework(...).matches will be false for this one.
      testDb.assessment.create({
        data: {
          orgId: orgA.id,
          projectId: projectA.id,
          userId: ownerA,
          mode: 'full',
          frameworkVersionId: 'fv_bogus_task6',
          engineState: {},
        },
      }),
      // Fix round 2, Important 1: BOTH completed AND pinned to the bogus
      // row -- the combined state no test covered before this round.
      testDb.assessment.create({
        data: {
          orgId: orgA.id,
          projectId: projectA.id,
          userId: ownerA,
          mode: 'full',
          frameworkVersionId: 'fv_bogus_task6',
          engineState: {},
          status: 'completed',
          completedAt: new Date(),
        },
      }),
    ]);
    assessmentMainId = main.id;
    assessmentOtherId = other.id;
    assessmentCompletedId = completed.id;
    assessmentDriftedId = drifted.id;
    assessmentCompletedDriftedId = completedDrifted.id;

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

    // Fix round 1, Minor 2: a remediation item belonging to org B entirely
    // (not merely a different assessment within org A) -- the converse-of-O-6
    // target: RLS should already exclude it before O-6's own confinement
    // check ever runs, a DIFFERENT claim from "same org, wrong assessment".
    const remediationOnOrgB = await testDb.remediationItem.create({
      data: {
        orgId: orgB.id,
        assessmentId: orgBAssessmentId,
        areaId: 'PO-03',
        areaName: 'Accountability',
        tier: 'gap',
        description: 'Belongs to org B entirely -- the O-1/O-6 converse target',
      },
    });
    remediationOnOrgBId = remediationOnOrgB.id;
  });

  afterAll(async () => {
    // Mirrors framework-hash.test.ts's own cleanup shape and reasoning:
    // Assessment.frameworkVersion carries no onDelete: Cascade (a pin must
    // not silently vanish), so the assessment pinned to fv_bogus_task6 must
    // be deleted BEFORE the framework_versions row itself, or Postgres
    // correctly refuses the delete with a live FK reference.
    await testDb.assessment.deleteMany({ where: { frameworkVersionId: 'fv_bogus_task6' } });
    await testDb.frameworkVersion.deleteMany({ where: { id: 'fv_bogus_task6' } });
  });

  // ---- Check 1: identity ---------------------------------------------

  it('rejects an unauthenticated request (401) -- proves the route actually calls requireOrgContextWithIdentity', async () => {
    currentSession = null;
    const res = await postEvidence(orgA.slug, assessmentMainId, evidenceFormData({ questionId: 'Q-PP-01' }));
    expect(res.status).toBe(401);
  });

  // ---- Check 2: size gate before buffering ---------------------------

  it('rejects a request whose declared Content-Length exceeds MAX_BYTES (413) -- the pre-buffer size gate', async () => {
    sessionFor(ownerA);
    const res = await postEvidence(orgA.slug, assessmentMainId, { contentLength: MAX_BYTES + 1 });
    // Fix round 1, Minor 4: 413 Payload Too Large, not 400 -- the correct
    // HTTP status for "the request entity is too large", distinct from a
    // generically malformed request.
    expect(res.status).toBe(413);
    // Message too, not just status -- see the non-numeric test below for
    // why status alone was not sufficient proof this specific gate fired
    // (413 vs. 400 is now itself a distinguishing signal, but the message
    // check stays: it is still accurate and still cheap).
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('File too large');
  });

  it('rejects a non-numeric Content-Length (413, from the SIZE GATE specifically) -- silent-failure-hunter finding: Number("abc") > MAX_BYTES is NaN > MAX_BYTES, which is false, so this must NOT silently pass the gate', async () => {
    sessionFor(ownerA);
    const res = await postEvidence(orgA.slug, assessmentMainId, { rawContentLength: 'abc' });
    expect(res.status).toBe(413);
    // Asserting the STATUS alone would have been vacuous when this test was
    // first written (both this gate and the unrelated formData-parse catch
    // returned 400) -- the status codes have since diverged (this gate now
    // returns 413), which is itself now a distinguishing signal, but the
    // message assertion is kept: it proves THIS check specifically, not
    // merely "some 413-shaped thing", produced the rejection.
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('File too large');
  });

  it('rejects a negative Content-Length (413, from the SIZE GATE specifically) -- same fail-closed requirement as the non-numeric case', async () => {
    sessionFor(ownerA);
    const res = await postEvidence(orgA.slug, assessmentMainId, { rawContentLength: '-5' });
    expect(res.status).toBe(413);
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

  // Found while addressing fix round 1's Minor 1 (assert body.error, not
  // just status, for every 400): this specific branch -- exactly one of
  // questionId/remediationItemId required -- had NO test at all. Every
  // other test in this file supplies exactly one of the two by
  // construction, so nothing had ever exercised "both" or "neither".
  it('rejects a request supplying BOTH questionId and remediationItemId (400)', async () => {
    sessionFor(ownerA);
    const res = await postEvidence(
      orgA.slug,
      assessmentMainId,
      evidenceFormData({ questionId: 'Q-PP-01', remediationItemId: remediationOnOtherId }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Exactly one of questionId or remediationItemId is required');
  });

  it('rejects a request supplying NEITHER questionId nor remediationItemId (400)', async () => {
    sessionFor(ownerA);
    const res = await postEvidence(orgA.slug, assessmentMainId, evidenceFormData({}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Exactly one of questionId or remediationItemId is required');
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

  // Fix round 1, Minor 2: O-6's test above proves confinement WITHIN one
  // org (same org, different assessment) -- it does not, and cannot, prove
  // anything about a target from a DIFFERENT org, because RLS filters that
  // case out before O-6's own check ever runs. This is the converse case,
  // and it is a DIFFERENT claim (O-1's cross-org isolation, exercised here
  // through the POST route rather than only through listEvidenceForAssessment
  // as the existing O-1 test does) -- this project has previously conflated
  // exactly this shape of "two different claims, one test" once already
  // (an invitation test once stood in as proof of two-org isolation, which
  // it could not establish), so it is asserted as its own test rather than
  // assumed to follow from the O-6 test above.
  it('rejects a remediationItemId belonging to a DIFFERENT ORG posted against an org A assessment (O-1, via the POST route)', async () => {
    sessionFor(ownerA);
    const res = await postEvidence(
      orgA.slug,
      assessmentMainId,
      evidenceFormData({ remediationItemId: remediationOnOrgBId }),
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
    // Fix round 1, Minor 1: status alone is not distinguishing -- five
    // different branches in this route return 400. The message is what
    // proves THIS check (O-22), not e.g. the missing-file or
    // exactly-one-attach-target check, produced the rejection.
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('questionId does not exist in the pinned framework version');
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
    // Fix round 1, Important 1: distinct from the O-14 drift 409 below --
    // both are 409, but with DIFFERENT messages now, precisely so a test
    // can tell them apart. See that test for the non-vacuity proof this
    // one is the counterpart of.
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Assessment does not accept new evidence');
  });

  // ---- O-14: deployed content that has drifted from the pin accepts no
  // further input (fix round 1, Important 1) -----------------------------

  it('rejects an upload when deployed content has drifted from what this assessment pinned (O-14, 409, DISTINCT from O-24 completed)', async () => {
    sessionFor(ownerA);
    const res = await postEvidence(orgA.slug, assessmentDriftedId, evidenceFormData({ questionId: 'Q-PP-09' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    // Before fix round 1, this and O-24's message above were IDENTICAL --
    // deleting the drift check entirely left the whole 1269-test suite
    // green, because no assertion anywhere could tell "rejected for drift"
    // apart from "rejected because completed" or from "not rejected at
    // all". This exact string is what makes that impossible now.
    expect(body.error).toBe('Framework content has drifted since this assessment was pinned');
  });

  // ---- O-24 vs O-14, combined state (fix round 2, Important 1) ---------

  it('rejects an upload to an assessment that is BOTH completed AND drifted with the COMPLETED message, not the drift one', async () => {
    // Coordinator's fix-round-2 finding: respondToAssessment (lib/data/
    // assessments.ts) checks 'completed' before drift, on the reasoning
    // that once completed, O-24 immutability is the controlling, simpler
    // reason a write is refused -- reporting drift instead would wrongly
    // imply reconciling content would re-open editing, which completion
    // already forecloses regardless. This route previously checked them
    // the OTHER way (drift first), so the SAME real state produced a
    // DIFFERENT explanation depending on which endpoint was hit. Reordered
    // to match; this is the non-vacuity proof for that reorder.
    sessionFor(ownerA);
    const res = await postEvidence(
      orgA.slug,
      assessmentCompletedDriftedId,
      evidenceFormData({ questionId: 'Q-PP-10' }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Assessment does not accept new evidence');
    expect(body.error).not.toBe('Framework content has drifted since this assessment was pinned');
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
