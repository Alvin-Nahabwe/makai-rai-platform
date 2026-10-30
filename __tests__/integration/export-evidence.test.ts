import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetDb, testDb, SEEDED_FRAMEWORK_VERSION_ID } from '../helpers/db';
import { buildOrg } from '../helpers/recordFixture';

/**
 * Task 11 (O-12). `GET /api/users/me/export` already exports the caller's
 * OWN profile fields and OWN `ConsentRecord` rows -- personal data the user
 * themselves generated. Evidence rows carry `uploadedById`: the same kind of
 * fact about THIS specific user (they uploaded this), even though the table
 * itself is tenant data. Task 11's brief: an export that silently omits a
 * category the user authored is a false statement about what the system
 * holds.
 *
 * BYTES: deliberately NOT included -- see task-11-report.md for the full
 * reasoning (unbounded aggregate size with no pagination/streaming on this
 * route, base64's ~4/3 inflation, and the existing per-item download route
 * already serving the same bytes with its own SHA-256 verification, O-9).
 * `evidence: []` cannot contain a byte payload for a test to assert is
 * ABSENT in the ordinary sense, so the negative assertion below checks the
 * shape of each item directly: no `content`/`bytes`/`base64` key of any kind.
 *
 * SESSION MOCKING: identical seam to password-gate.test.ts and
 * evidence-upload.test.ts -- `requireIdentityForApi` dynamically imports
 * `lib/auth.ts` and calls its `auth()` export.
 *
 * FIXTURES: evidence rows are built directly via `testDb` (superuser,
 * bypasses RLS), the same convention evidence-upload.test.ts's own fixture
 * setup uses for rows this suite is not exercising the WRITE path for --
 * this file tests the EXPORT READ path, not upload.
 */

let currentSession: { user: { id: string }; sessionEpoch: number; sessionIssuedAt: number } | null = null;

vi.mock('../../lib/auth', () => ({
  auth: () => Promise.resolve(currentSession),
}));

function sessionFor(userId: string): void {
  currentSession = { user: { id: userId }, sessionEpoch: 0, sessionIssuedAt: Math.floor(Date.now() / 1000) };
}

async function makeOrgProjectAssessment(ownerEmail: string) {
  // An organisation and its owner (K0a's buildOrg), the owner under this email.
  const fx = await buildOrg();
  const boot = { userId: fx.members.owner.userId, orgId: fx.org.id, slug: fx.org.slug };
  await testDb.user.update({ where: { id: boot.userId }, data: { email: ownerEmail, name: 'Export Test Owner' } });
  const project = await testDb.project.create({
    data: { orgId: boot.orgId, name: 'Export Test Project', createdById: boot.userId },
  });
  const assessment = await testDb.assessment.create({
    data: {
      orgId: boot.orgId,
      projectId: project.id,
      userId: boot.userId,
      frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
      engineState: {} as never,
    },
  });
  return { ...boot, projectId: project.id, assessmentId: assessment.id };
}

async function createEvidenceRow(opts: {
  orgId: string;
  assessmentId: string;
  uploadedById: string;
  filename?: string;
  content?: Buffer;
}) {
  const content = opts.content ?? Buffer.from('89504e470d0a1a0a', 'hex'); // PNG magic bytes
  const sha256 = createHash('sha256').update(content).digest('hex');
  const row = await testDb.evidence.create({
    data: {
      orgId: opts.orgId,
      assessmentId: opts.assessmentId,
      frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
      questionId: 'Q-PP-01',
      filename: opts.filename ?? 'evidence.png',
      mimeType: 'image/png',
      byteSize: content.byteLength,
      sha256,
      uploadedById: opts.uploadedById,
    },
  });
  await testDb.evidenceBlob.create({
    data: { evidenceId: row.id, orgId: opts.orgId, content: new Uint8Array(content) },
  });
  return { row, sha256 };
}

beforeEach(resetDb);

describe('GET /api/users/me/export includes evidence (O-12)', () => {
  it("includes evidence metadata the caller uploaded, with no byte payload of any kind", async () => {
    const owner = await makeOrgProjectAssessment('export-owner-1@uni.ac.ug');
    const { row, sha256 } = await createEvidenceRow({
      orgId: owner.orgId,
      assessmentId: owner.assessmentId,
      uploadedById: owner.userId,
      filename: 'consent-form.png',
    });
    sessionFor(owner.userId);

    const { GET } = await import('../../app/api/users/me/export/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.evidence)).toBe(true);
    expect(body.evidence).toHaveLength(1);
    const item = body.evidence[0];
    expect(item.id).toBe(row.id);
    expect(item.filename).toBe('consent-form.png');
    expect(item.sha256).toBe(sha256);
    expect(item.assessmentId).toBe(owner.assessmentId);
    expect(item.orgId).toBe(owner.orgId);

    // O-12's own constraint: whatever shape is chosen, no byte payload
    // travels through this route -- checked by key name, not merely by
    // this fixture's own field list, so a future field named `content` or
    // `base64Content` would also be caught. Word-bounded so it does not
    // false-positive on the perfectly legitimate `byteSize` (a number
    // ABOUT the file, not the file) -- confirmed to actually discriminate
    // by first running this against the real response with the naive,
    // unbounded /bytes/i, which DID flag `byteSize` (a real red, for the
    // wrong reason, from this test's own detector rather than the route).
    const suspiciousKeys = Object.keys(item).filter((k) =>
      /\bcontent\b|\bbytes\b|base64/i.test(k),
    );
    expect(suspiciousKeys).toEqual([]);
  });

  it("excludes evidence uploaded by a different member of the same org", async () => {
    const owner = await makeOrgProjectAssessment('export-owner-2@uni.ac.ug');
    const otherUser = await testDb.user.create({
      data: { email: 'export-colleague-2@uni.ac.ug', name: 'Colleague', passwordHash: 'x' },
    });
    await testDb.membership.create({
      data: { orgId: owner.orgId, userId: otherUser.id, role: 'assessor' },
    });
    await createEvidenceRow({
      orgId: owner.orgId,
      assessmentId: owner.assessmentId,
      uploadedById: otherUser.id,
    });
    sessionFor(owner.userId);

    const { GET } = await import('../../app/api/users/me/export/route');
    const res = await GET();
    const body = await res.json();
    expect(body.evidence).toEqual([]);
  });

  it("stops including evidence from an org once the caller's membership there is no longer active", async () => {
    const owner = await makeOrgProjectAssessment('export-owner-3@uni.ac.ug');
    await createEvidenceRow({
      orgId: owner.orgId,
      assessmentId: owner.assessmentId,
      uploadedById: owner.userId,
    });
    sessionFor(owner.userId);
    const { GET } = await import('../../app/api/users/me/export/route');

    // Sanity: present while the membership is active.
    const before = await (await GET()).json();
    expect(before.evidence).toHaveLength(1);

    // The export must not become a way to read evidence the caller could
    // not read through the normal route (task-11-brief.md's own
    // constraint) -- and the normal route (requireOrgContext) refuses a
    // suspended membership exactly like a nonexistent one
    // (org-context.test.ts's "refuses a suspended membership").
    await testDb.membership.updateMany({
      where: { orgId: owner.orgId, userId: owner.userId },
      data: { status: 'suspended' },
    });

    const after = await (await GET()).json();
    expect(after.evidence).toEqual([]);
  });

  it('returns an empty evidence array for a caller who has uploaded none', async () => {
    const owner = await makeOrgProjectAssessment('export-owner-4@uni.ac.ug');
    sessionFor(owner.userId);

    const { GET } = await import('../../app/api/users/me/export/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.evidence).toEqual([]);
  });
});
