import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { testDb, resetDb, SEEDED_FRAMEWORK_VERSION_ID } from '../helpers/db';
import { buildTwoOrgFixture, type TwoOrgFixture, type FixtureOrg } from '../helpers/fixture';
import { GET as getAssessment } from '../../app/api/v1/orgs/[slug]/assessments/[id]/route';
import { GET as getPdf, toEvidenceManifest } from '../../app/api/v1/orgs/[slug]/reports/[id]/pdf/route';
import { resolveFramework } from '../../lib/data/framework';
import { listEvidenceForAssessment } from '../../lib/data/evidence';
import { lookupUserNames } from '../../lib/data/identity';
import { isFrameworkDrifted } from '../../lib/report/provenance';
import { withOrg, type OrgContext } from '../../lib/data/tenant';

/**
 * Plan 1c Task 9. `report-provenance.test.tsx` (the brief's own named
 * deliverable) proves O-14/O-15/O-16 at the COMPONENT level: given hand-fed
 * props, ReportSummary/ReportPdf render the right thing. It cannot prove
 * the other half of the claim -- that the two ROUTES this task had to wire
 * (app/api/v1/orgs/[slug]/assessments/[id]/route.ts,
 * app/api/v1/orgs/[slug]/reports/[id]/pdf/route.ts; neither named in the
 * brief's own file list, see task-9-report.md) actually COMPUTE `matches`,
 * the pin date, and the evidence manifest correctly from REAL database
 * state. Those are two different claims and neither test proves the other
 * (AGENTS.md §3: "state the connections, not only what they are").
 *
 * WHY THIS FILE DOES NOT GREP RENDERED PDF BYTES FOR FILENAMES OR BANNER
 * TEXT (an earlier draft did, and it was WRONG): @react-pdf/renderer's real
 * `renderToBuffer` output writes `<Text>` content as hex-encoded glyph-ID
 * show operators (`[<47656e6572...>] TJ`), never as literal PDF strings --
 * confirmed by reading `node_modules/@react-pdf/render/lib/index.js`
 * (`_renderGlyphs`) and by a live probe for this task (see
 * task-9-report.md). A literal filename or banner sentence NEVER appears
 * as literal text in a rendered PDF's content stream, compressed or not,
 * REGARDLESS of whether the code is correct -- so a test asserting
 * `toContain('bias-audit.pdf')` or `toMatch(/differs from the pinned/)`
 * against decompressed PDF bytes cannot pass for the right reason. Worse,
 * the CONVERSE assertion (`not.toContain(...)`) is VACUOUS in the other
 * direction: it "passes" whether the banner rendered or not, because the
 * search string could never appear either way. This file instead verifies
 * (a) the exact functions that COMPUTE the drifted/manifest values,
 * against real fetched database rows, and (b) a structural signal
 * (rendered PDF byte length) for whether the extra banner content was
 * actually emitted -- neither depends on parsing glyph-encoded text.
 * `report-provenance.test.tsx`'s component-level tests already prove the
 * RENDERING side correctly, by inspecting the React element tree BEFORE
 * @react-pdf/renderer's glyph-encoding pass ever runs.
 *
 * SESSION MOCKING / FIXTURES: identical seam and shape to
 * evidence-upload.test.ts (Task 6) -- `buildTwoOrgFixture()`, the
 * `fv_bogus`-row-plus-mispinned-assessment technique
 * `framework-hash.test.ts` and `evidence-upload.test.ts` both already use
 * for a real `resolveFramework(...).matches === false` fixture, and
 * `vi.mock('../../lib/auth')` for the one mockable session seam.
 */
let currentSession: { user: { id: string }; sessionEpoch: number; sessionIssuedAt: number } | null = null;

vi.mock('../../lib/auth', () => ({
  auth: () => Promise.resolve(currentSession),
}));

function sessionFor(userId: string): void {
  currentSession = { user: { id: userId }, sessionEpoch: 0, sessionIssuedAt: Math.floor(Date.now() / 1000) };
}

function reportDataFor(overallScore: number) {
  return {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    completedStages: ['pre-processing'],
    overallScore,
    stageScores: { 'pre-processing': { Fairness: overallScore } },
    principleScores: { 'pre-processing': { Fairness: overallScore } },
    activeModifiers: [],
    unlockedConditionals: [],
  };
}

function ctxFor(orgId: string): OrgContext {
  // Same documented escape hatch every integration test uses (fixture.ts's
  // own `ownerContext`, evidence-upload.test.ts's `ctxFor`) -- OrgContext
  // is branded specifically to stop accidental construction; a deliberate
  // `as` cast in a test is the established, sanctioned exception.
  return { orgId, role: 'owner' } as OrgContext;
}

describe('report surface route wiring -- assessment GET + PDF GET (O-14 completed half, O-15, O-16, end to end)', () => {
  let fixture: TwoOrgFixture;
  let orgA: FixtureOrg;
  let ownerA: string;
  let matchingId: string;
  let driftedId: string;
  // A clean pair differing ONLY in drift status -- same reportData, same
  // (zero) evidence -- so a PDF byte-length comparison between them
  // isolates the drift banner's own contribution, not a confound from
  // evidence count or score text length.
  let sizeMatchingId: string;
  let sizeDriftedId: string;

  beforeAll(async () => {
    await resetDb();
    fixture = await buildTwoOrgFixture();
    [orgA] = fixture.orgs;
    const owner = fixture.users.find((u) => u.orgSlug === orgA.slug && u.role === 'owner' && u.index === 0);
    if (!owner) throw new Error('fixture must carry a bootstrap owner for org A');
    ownerA = owner.userId;

    const project = await testDb.project.create({
      data: { orgId: orgA.id, name: 'Report provenance probe project', createdById: ownerA },
    });

    // Same technique as evidence-upload.test.ts / framework-hash.test.ts --
    // a second framework_versions row with a deliberately wrong
    // contentHash, since the migration's seeded row is correct by
    // construction and is the only way to make
    // resolveFramework(...).matches false. Distinct id from every OTHER
    // test file's own bogus row so no fixture state is shared.
    await testDb.$executeRaw`
      INSERT INTO "framework_versions" ("id","semver","contentHash","publishedAt")
      VALUES ('fv_bogus_task9','9.9.9-task9','0000000000000000000000000000000000000000000000000000000000000000', now())
      ON CONFLICT ("id") DO NOTHING`;
    // A SECOND bogus row, semver 'x.x.x' -- deliberately the SAME LENGTH
    // (5 characters) as the real seeded '3.0.0' (checked:
    // SEEDED_FRAMEWORK_VERSION_ID's own semver, asserted again below).
    // Caught live while proving the byte-length comparison test's own
    // non-vacuity (task-9-report.md): with 'fv_bogus_task9' (semver
    // '9.9.9-task9', 11 characters) the "drifted PDF is bigger" assertion
    // PASSED even with the drift banner's render guard forced `false`,
    // because the PROVENANCE LINE ITSELF renders a longer semver string
    // for that fixture regardless of the banner -- a confound, not proof
    // of the banner. A same-length bogus semver removes it: the provenance
    // line's rendered length is now identical between the two fixtures, so
    // only the banner block can account for a size difference.
    await testDb.$executeRaw`
      INSERT INTO "framework_versions" ("id","semver","contentHash","publishedAt")
      VALUES ('fv_bogus_task9_samelen','x.x.x','1111111111111111111111111111111111111111111111111111111111111111', now())
      ON CONFLICT ("id") DO NOTHING`;

    const commonReportData = reportDataFor(50);
    const [matching, drifted, sizeMatching, sizeDrifted] = await Promise.all([
      testDb.assessment.create({
        data: {
          orgId: orgA.id, projectId: project.id, userId: ownerA, mode: 'full',
          frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID, engineState: {},
          status: 'completed', completedAt: new Date(), overallScore: 62,
          reportData: reportDataFor(62),
        },
      }),
      testDb.assessment.create({
        data: {
          orgId: orgA.id, projectId: project.id, userId: ownerA, mode: 'full',
          frameworkVersionId: 'fv_bogus_task9', engineState: {},
          status: 'completed', completedAt: new Date(), overallScore: 40,
          reportData: reportDataFor(40),
        },
      }),
      testDb.assessment.create({
        data: {
          orgId: orgA.id, projectId: project.id, userId: ownerA, mode: 'full',
          frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID, engineState: {},
          status: 'completed', completedAt: new Date(), overallScore: 50,
          reportData: commonReportData,
        },
      }),
      testDb.assessment.create({
        data: {
          orgId: orgA.id, projectId: project.id, userId: ownerA, mode: 'full',
          frameworkVersionId: 'fv_bogus_task9_samelen', engineState: {},
          status: 'completed', completedAt: new Date(), overallScore: 50,
          reportData: commonReportData,
        },
      }),
    ]);
    matchingId = matching.id;
    driftedId = drifted.id;
    sizeMatchingId = sizeMatching.id;
    sizeDriftedId = sizeDrifted.id;

    // One real evidence row on the MATCHING assessment, attached to a real
    // question id (Q-PP-01, confirmed present by
    // __tests__/unit/evidence-data.test.ts's own use of it) -- so the
    // "toEvidenceManifest against real rows" test below exercises data
    // that actually round-tripped through the database, not only a
    // hand-built fixture object. Built directly via testDb, the same
    // convention every other integration file in this suite uses for its
    // own domain resources (evidence-upload.test.ts's own module doc
    // comment).
    const content = Buffer.from('%PDF-1.4 probe content for report-provenance.test.ts');
    const evidenceRow = await testDb.evidence.create({
      data: {
        orgId: orgA.id,
        assessmentId: matchingId,
        frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
        questionId: 'Q-PP-01',
        remediationItemId: null,
        filename: 'bias-audit-report.pdf',
        mimeType: 'application/pdf',
        byteSize: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        uploadedById: ownerA,
      },
    });
    await testDb.evidenceBlob.create({
      data: { evidenceId: evidenceRow.id, orgId: orgA.id, content: new Uint8Array(content) },
    });

    sessionFor(ownerA);
  });

  function getAssessmentReq(assessmentId: string) {
    const req = new NextRequest('http://localhost/probe', { method: 'GET' });
    return getAssessment(req, { params: Promise.resolve({ slug: orgA.slug, id: assessmentId }) });
  }

  function getPdfReq(assessmentId: string) {
    const req = new NextRequest('http://localhost/probe', { method: 'GET' });
    return getPdf(req, { params: Promise.resolve({ slug: orgA.slug, id: assessmentId }) });
  }

  describe('assessment GET route -- carries framework.{semver,contentHash,matches} (O-15/O-14 data half)', () => {
    it('reports matches: true and the real seeded semver/hash for an assessment pinned to the current content', async () => {
      const seeded = await testDb.frameworkVersion.findUniqueOrThrow({ where: { id: SEEDED_FRAMEWORK_VERSION_ID } });
      const res = await getAssessmentReq(matchingId);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.framework).toEqual({ semver: seeded.semver, contentHash: seeded.contentHash, matches: true });
    });

    it('reports matches: false for an assessment pinned to a framework_versions row with the wrong contentHash', async () => {
      const res = await getAssessmentReq(driftedId);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.framework).toMatchObject({ semver: '9.9.9-task9', matches: false });
    });
  });

  describe('isFrameworkDrifted(assessment.status, resolveFramework(...).matches) against real rows -- the exact chain both routes call', () => {
    it('is true for a completed assessment pinned to a mismatched framework_versions row', async () => {
      const ctx = ctxFor(orgA.id);
      const { resolution, status } = await withOrg(ctx, async (tx) => {
        const resolution = await resolveFramework(driftedId, tx);
        const a = await tx.assessment.findUniqueOrThrow({ where: { id: driftedId }, select: { status: true } });
        return { resolution, status: a.status };
      });
      expect(resolution).not.toBeNull();
      expect(isFrameworkDrifted(status, resolution!.matches)).toBe(true);
    });

    it('is false for a completed assessment pinned to the current content', async () => {
      const ctx = ctxFor(orgA.id);
      const { resolution, status } = await withOrg(ctx, async (tx) => {
        const resolution = await resolveFramework(matchingId, tx);
        const a = await tx.assessment.findUniqueOrThrow({ where: { id: matchingId }, select: { status: true } });
        return { resolution, status: a.status };
      });
      expect(resolution).not.toBeNull();
      expect(isFrameworkDrifted(status, resolution!.matches)).toBe(false);
    });
  });

  describe('toEvidenceManifest against evidence actually fetched from the database (O-16 wiring)', () => {
    it('shapes a real evidence row, round-tripped through Postgres, into the manifest form ReportPdf renders', async () => {
      const ctx = ctxFor(orgA.id);
      const evidence = await withOrg(ctx, (tx) => listEvidenceForAssessment(matchingId, tx));
      expect(evidence).toHaveLength(1);
      const names = await lookupUserNames([ownerA]);
      const manifest = toEvidenceManifest(evidence, names);
      expect(manifest).toEqual([
        {
          filename: 'bias-audit-report.pdf',
          sha256: createHash('sha256').update('%PDF-1.4 probe content for report-provenance.test.ts').digest('hex'),
          uploaderName: names.get(ownerA)!.name,
          uploadedAt: evidence[0].uploadedAt.toISOString().split('T')[0],
        },
      ]);
    });

    it('is empty for an assessment with no evidence', async () => {
      const ctx = ctxFor(orgA.id);
      const evidence = await withOrg(ctx, (tx) => listEvidenceForAssessment(driftedId, tx));
      expect(toEvidenceManifest(evidence, new Map())).toEqual([]);
    });
  });

  describe('PDF GET route -- produces a valid, bounded document and reacts to real drift state (O-16 size bound, O-14 completed half structural signal)', () => {
    it('returns a valid, bounded application/pdf document for a matching, completed assessment', async () => {
      const res = await getPdfReq(matchingId);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      // O-16 "stays bounded" -- a rough sanity ceiling, not a precise
      // budget: this document carries one evidence row and one principle
      // score, nowhere near large enough to justify megabytes.
      expect(buf.byteLength).toBeLessThan(200_000);
    });

    it('also returns a valid, bounded document for a completed, DRIFTED assessment -- viewing/exporting an existing report is never blocked by drift, only new input is (Task 6)', async () => {
      const res = await getPdfReq(driftedId);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    });

    /**
     * Structural, non-text signal that the drift banner block was actually
     * emitted into the real rendered document for a real drifted fixture --
     * not just given a hand-fed `frameworkDrifted: true` prop
     * (`report-provenance.test.tsx` already proves THAT half). Two
     * otherwise-IDENTICAL fixtures (`sizeMatchingId`/`sizeDriftedId`: same
     * reportData, same zero evidence rows, differing ONLY in
     * `frameworkVersionId`) isolate the banner's own contribution --
     * anything else that could change PDF size (evidence count, score
     * text length) is held constant between the two.
     */
    it('renders a measurably larger PDF for a drifted assessment than an otherwise-identical matching one (drift banner content reaches the real document)', async () => {
      // Sequential, not Promise.all: invoking this route handler twice
      // CONCURRENTLY hit a real environment issue -- "Cannot find module
      // .../node_modules/next/server imported from next-auth/lib/env.js"
      // -- reproducible in isolation (`-t` filtered to just this test), so
      // it is not test-order flakiness. This test claims nothing about
      // concurrent behaviour, only about two sizes to compare, so
      // sequential awaits are the more appropriate shape regardless; see
      // task-9-report.md for the investigation and why this was not
      // treated as a defect in the route being tested.
      // The "same length" premise the fixture comment above claims,
      // checked here rather than only asserted: if this ever drifts (the
      // seeded semver changes length), the confound returns silently
      // unless this precondition is verified every run.
      const seeded = await testDb.frameworkVersion.findUniqueOrThrow({ where: { id: SEEDED_FRAMEWORK_VERSION_ID } });
      expect(seeded.semver.length).toBe('x.x.x'.length);

      const matchingRes = await getPdfReq(sizeMatchingId);
      const matchingBuf = Buffer.from(await matchingRes.arrayBuffer());
      const driftedRes = await getPdfReq(sizeDriftedId);
      const driftedBuf = Buffer.from(await driftedRes.arrayBuffer());
      expect(driftedBuf.byteLength).toBeGreaterThan(matchingBuf.byteLength);
    });
  });
});
