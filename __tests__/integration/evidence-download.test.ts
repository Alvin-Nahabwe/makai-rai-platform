import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { testDb, resetDb, SEEDED_FRAMEWORK_VERSION_ID } from '../helpers/db';
import { buildTwoOrgFixture, type TwoOrgFixture, type FixtureOrg } from '../helpers/fixture';
import { GET, DELETE, buildContentDisposition } from '../../app/api/v1/orgs/[slug]/evidence/[evidenceId]/route';

/**
 * Task 7 -- the download route (its DELETE method answers 404 since v0.6.0,
 * FR-AUTHZ-02, and the cases of the removed delete are gone). Covers the brief's
 * Step 1 list (O-8 x3, O-9) PLUS fresh findings from this task's own
 * C1 senior-security pass (task-7-report.md), derived fresh rather than
 * reused from Task 6's upload threat table (AGENTS.md §7.1): Content-Length
 * must come from the bytes actually served, not the separately-stored
 * byteSize column; a missing blob row is a distinct fail-closed case from a
 * hash mismatch; and the integrity-failure response body must not leak the
 * hash values it is refusing to serve over.
 *
 * FIXTURES: evidence/evidence_blobs rows are written DIRECTLY via testDb
 * (bypassing the real upload route and its inspect() gate), matching the
 * established convention for domain fixture data in this suite
 * (evidence-schema.test.ts, permission-matrix.test.ts's buildOrgResources,
 * evidence-upload.test.ts's own assessments) -- what this file tests is the
 * DOWNLOAD path, not upload validation, and testDb is the schema
 * owner (BYPASSRLS), so it can also directly corrupt/omit a blob row to
 * simulate corruption -- something the app role's grants (SELECT, INSERT,
 * DELETE only, no UPDATE) cannot do to itself, which is exactly why O-9's
 * "the only ways to get there are corruption or tampering" framing holds.
 *
 * SESSION MOCKING: identical seam and shape to evidence-upload.test.ts and
 * permission-matrix.test.ts.
 */

let currentSession: { user: { id: string }; sessionEpoch: number; sessionIssuedAt: number } | null = null;

vi.mock('../../lib/auth', () => ({
  auth: () => Promise.resolve(currentSession),
}));

function sessionFor(userId: string): void {
  currentSession = { user: { id: userId }, sessionEpoch: 0, sessionIssuedAt: Math.floor(Date.now() / 1000) };
}

function downloadEvidence(slug: string, evidenceId: string): Promise<Response> {
  const req = new NextRequest('http://localhost/probe', { method: 'GET' });
  return GET(req, { params: Promise.resolve({ slug, evidenceId }) });
}

function deleteEvidence(slug: string, evidenceId: string): Promise<Response> {
  const req = new NextRequest('http://localhost/probe', { method: 'DELETE' });
  return DELETE(req, { params: Promise.resolve({ slug, evidenceId }) });
}

/**
 * Direct-write fixture helper -- mirrors createEvidence's shape (lib/data/evidence.ts)
 * but exposes every field that helper deliberately does not let a caller
 * override (sha256, byteSize, whether a blob exists at all), because THIS
 * file's whole point is to exercise the routes against rows that are
 * internally inconsistent in exactly the ways createEvidence can never
 * produce.
 */
async function insertEvidence(opts: {
  id: string;
  orgId: string;
  assessmentId: string;
  filename: string;
  mimeType?: string;
  content: Buffer;
  sha256?: string;
  byteSize?: number;
  withBlob?: boolean;
}): Promise<void> {
  await testDb.evidence.create({
    data: {
      id: opts.id,
      orgId: opts.orgId,
      assessmentId: opts.assessmentId,
      frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
      questionId: `Q-${opts.id}`,
      filename: opts.filename,
      mimeType: opts.mimeType ?? 'application/pdf',
      byteSize: opts.byteSize ?? opts.content.byteLength,
      sha256: opts.sha256 ?? createHash('sha256').update(opts.content).digest('hex'),
    },
  });
  if (opts.withBlob ?? true) {
    await testDb.evidenceBlob.create({
      data: { evidenceId: opts.id, orgId: opts.orgId, content: new Uint8Array(opts.content) },
    });
  }
}

const NORMAL_FILENAME = 'annual-report.pdf';
const NORMAL_CONTENT = Buffer.from('normal-evidence-bytes');

// Header-injection payload. Computed and cross-checked against Node's real
// encodeURIComponent (not hand-arithmetic alone) before being hardcoded here:
// ascii = 'evil__Set-Cookie: hacked=1' (CR, LF -> '_'); encoded =
// 'evil%0D%0ASet-Cookie%3A%20hacked%3D1'.
const CRLF_FILENAME = 'evil\r\nSet-Cookie: hacked=1';
const CRLF_CONTENT = Buffer.from('crlf-evidence-bytes');

// Quoted-string breakout payload, carrying BOTH a double quote and a
// backslash. ascii = 'evil_.txt_, x=_pwned' ("/\\ -> '_'); encoded =
// 'evil%5C.txt%22%2C%20x%3D%22pwned'.
const QUOTE_BACKSLASH_FILENAME = 'evil\\.txt", x="pwned';
const QUOTE_BACKSLASH_CONTENT = Buffer.from('quote-evidence-bytes');

const HASH_MISMATCH_ORIGINAL = Buffer.from('original-content-for-hash');
const HASH_MISMATCH_CORRUPTED = Buffer.from('CORRUPTED-content-for-hash-of-a-different-length');

const WRONG_BYTE_SIZE_CONTENT = Buffer.from('wrongsize-evidence-bytes-0123456789');
const WRONG_STORED_BYTE_SIZE = 3; // deliberately not WRONG_BYTE_SIZE_CONTENT.byteLength

const FOR_DELETE_CONTENT = Buffer.from('to-be-deleted-bytes');
const ON_COMPLETED_CONTENT = Buffer.from('frozen-bytes');
const ORG_B_CONTENT = Buffer.from('org-b-bytes');

describe('evidence download route', () => {
  let fixture: TwoOrgFixture;
  let orgA: FixtureOrg;
  let orgB: FixtureOrg;
  let ownerA: string;

  let assessmentInProgressId: string;
  let assessmentCompletedId: string;
  let orgBAssessmentId: string;

  let evidenceNormalId: string;
  let evidenceCrlfId: string;
  let evidenceQuoteBackslashId: string;
  let evidenceHashMismatchId: string;
  let evidenceMissingBlobId: string;
  let evidenceWrongByteSizeId: string;
  let evidenceOnCompletedId: string;
  let evidenceForDeleteId: string;
  let orgBEvidenceId: string;

  beforeAll(async () => {
    await resetDb();
    fixture = await buildTwoOrgFixture();
    [orgA, orgB] = fixture.orgs;
    const owner = fixture.users.find((u) => u.orgSlug === orgA.slug && u.role === 'owner' && u.index === 0);
    if (!owner) throw new Error('fixture must carry a bootstrap owner for org A');
    ownerA = owner.userId;
    const ownerB = fixture.users.find((u) => u.orgSlug === orgB.slug && u.role === 'owner' && u.index === 0);
    if (!ownerB) throw new Error('fixture must carry a bootstrap owner for org B');

    const projectA = await testDb.project.create({
      data: { orgId: orgA.id, name: 'Evidence download probe project A', createdById: ownerA },
    });
    const projectB = await testDb.project.create({
      data: { orgId: orgB.id, name: 'Evidence download probe project B', createdById: ownerB.userId },
    });

    const [inProgress, completed, orgBAssessment] = await Promise.all([
      testDb.assessment.create({
        data: {
          orgId: orgA.id, projectId: projectA.id, userId: ownerA,
          frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID, engineState: {},
        },
      }),
      testDb.assessment.create({
        data: {
          orgId: orgA.id, projectId: projectA.id, userId: ownerA,
          frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID, engineState: {},
          status: 'completed', completedAt: new Date(),
        },
      }),
      testDb.assessment.create({
        data: {
          orgId: orgB.id, projectId: projectB.id, userId: ownerB.userId,
          frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID, engineState: {},
        },
      }),
    ]);
    assessmentInProgressId = inProgress.id;
    assessmentCompletedId = completed.id;
    orgBAssessmentId = orgBAssessment.id;

    evidenceNormalId = 'ev-dl-normal';
    evidenceCrlfId = 'ev-dl-crlf';
    evidenceQuoteBackslashId = 'ev-dl-quote-backslash';
    evidenceHashMismatchId = 'ev-dl-hash-mismatch';
    evidenceMissingBlobId = 'ev-dl-missing-blob';
    evidenceWrongByteSizeId = 'ev-dl-wrong-byte-size';
    evidenceOnCompletedId = 'ev-dl-on-completed';
    evidenceForDeleteId = 'ev-dl-for-delete';
    orgBEvidenceId = 'ev-dl-org-b';

    await Promise.all([
      // Deliberately 'text/html' -- the sharpest possible proof that O-8
      // never trusts the stored mimeType: if Content-Type ever leaked
      // through, this is the fixture that would render/execute in a
      // browser instead of downloading.
      insertEvidence({
        id: evidenceNormalId, orgId: orgA.id, assessmentId: assessmentInProgressId,
        filename: NORMAL_FILENAME, mimeType: 'text/html', content: NORMAL_CONTENT,
      }),
      insertEvidence({
        id: evidenceCrlfId, orgId: orgA.id, assessmentId: assessmentInProgressId,
        filename: CRLF_FILENAME, content: CRLF_CONTENT,
      }),
      insertEvidence({
        id: evidenceQuoteBackslashId, orgId: orgA.id, assessmentId: assessmentInProgressId,
        filename: QUOTE_BACKSLASH_FILENAME, content: QUOTE_BACKSLASH_CONTENT,
      }),
      insertEvidence({
        id: evidenceMissingBlobId, orgId: orgA.id, assessmentId: assessmentInProgressId,
        filename: 'no-blob.pdf', content: Buffer.from('irrelevant'), withBlob: false,
      }),
      insertEvidence({
        id: evidenceWrongByteSizeId, orgId: orgA.id, assessmentId: assessmentInProgressId,
        filename: 'wrong-byte-size.pdf', content: WRONG_BYTE_SIZE_CONTENT, byteSize: WRONG_STORED_BYTE_SIZE,
      }),
      insertEvidence({
        id: evidenceOnCompletedId, orgId: orgA.id, assessmentId: assessmentCompletedId,
        filename: 'frozen.pdf', content: ON_COMPLETED_CONTENT,
      }),
      insertEvidence({
        id: evidenceForDeleteId, orgId: orgA.id, assessmentId: assessmentInProgressId,
        filename: 'for-delete.pdf', content: FOR_DELETE_CONTENT,
      }),
      insertEvidence({
        id: orgBEvidenceId, orgId: orgB.id, assessmentId: orgBAssessmentId,
        filename: 'org-b.pdf', content: ORG_B_CONTENT,
      }),
    ]);

    // Hash-mismatch fixture: stored sha256 is correct for the ORIGINAL
    // content at write time; the blob's actual bytes are then corrupted
    // in place, exactly the "corruption or tampering after the fact" shape
    // O-9 exists to catch -- not a row that was simply inserted wrong.
    await insertEvidence({
      id: evidenceHashMismatchId, orgId: orgA.id, assessmentId: assessmentInProgressId,
      filename: 'hash-mismatch.pdf', content: HASH_MISMATCH_ORIGINAL,
    });
    await testDb.evidenceBlob.update({
      where: { evidenceId: evidenceHashMismatchId },
      data: { content: new Uint8Array(HASH_MISMATCH_CORRUPTED) },
    });
  });

  // ---- O-8: hostile-safe response shape --------------------------------

  it('serves octet-stream as an attachment, discarding the stored mimeType', async () => {
    sessionFor(ownerA);
    const res = await downloadEvidence(orgA.slug, evidenceNormalId);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream'); // NOT 'text/html'
    // The nosniff header is nginx's alone (docker/nginx/default.conf, guarded by
    // __tests__/lint/security-headers.test.ts). A copy from the app would
    // reach the browser twice, so its absence here is the property.
    expect(res.headers.get('x-content-type-options')).toBeNull();
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="${NORMAL_FILENAME}"; filename*=UTF-8''${NORMAL_FILENAME}`,
    );
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(NORMAL_CONTENT)).toBe(true);
  });

  it('cannot be header-injected by a filename containing CRLF', async () => {
    sessionFor(ownerA);
    const res = await downloadEvidence(orgA.slug, evidenceCrlfId);
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition');
    // Exact value, not merely "response is 200" -- a test that only checks
    // status would pass with no escaping at all.
    expect(cd).toBe(
      `attachment; filename="evil__Set-Cookie: hacked=1"; filename*=UTF-8''evil%0D%0ASet-Cookie%3A%20hacked%3D1`,
    );
    expect(cd).not.toMatch(/[\r\n]/);
    // The sharpest available proof of "no injection occurred": no SECOND
    // header actually landed as a result of the payload's own text.
    expect(res.headers.get('x-injected')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('encodes a filename containing a double quote and a backslash per RFC 6266', async () => {
    sessionFor(ownerA);
    const res = await downloadEvidence(orgA.slug, evidenceQuoteBackslashId);
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition');
    expect(cd).toBe(
      `attachment; filename="evil_.txt_, x=_pwned"; filename*=UTF-8''evil%5C.txt%22%2C%20x%3D%22pwned`,
    );
    // Breakout proof: the quoted-string portion contains no unescaped `"`
    // beyond the two characters that wrap it.
    const quoted = /filename="([^]*?)";/.exec(cd ?? '')?.[1] ?? '';
    expect(quoted.includes('"')).toBe(false);
    expect(quoted.includes('\\')).toBe(false);
  });

  it('derives Content-Length from the bytes actually served, not the stored byteSize column', async () => {
    sessionFor(ownerA);
    const res = await downloadEvidence(orgA.slug, evidenceWrongByteSizeId);
    // The hash still matches (only byteSize is wrong), so this must succeed.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(WRONG_BYTE_SIZE_CONTENT.byteLength));
    expect(res.headers.get('content-length')).not.toBe(String(WRONG_STORED_BYTE_SIZE));
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(WRONG_BYTE_SIZE_CONTENT)).toBe(true);
  });

  // ---- O-9: integrity verified before responding ------------------------

  it('rejects the download if the stored bytes do not match the recorded sha256, without leaking hash values', async () => {
    sessionFor(ownerA);
    const res = await downloadEvidence(orgA.slug, evidenceHashMismatchId);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Internal server error');
    const raw = JSON.stringify(body);
    const storedHash = createHash('sha256').update(HASH_MISMATCH_ORIGINAL).digest('hex');
    const computedHash = createHash('sha256').update(HASH_MISMATCH_CORRUPTED).digest('hex');
    expect(raw).not.toContain(storedHash);
    expect(raw).not.toContain(computedHash);
  });

  it('fails closed when the evidence row has no blob row, rather than crashing (data-integrity anomaly distinct from a hash mismatch)', async () => {
    sessionFor(ownerA);
    const res = await downloadEvidence(orgA.slug, evidenceMissingBlobId);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Internal server error');
  });

  // Unit-level, not integration: a lone (unpaired) UTF-16 surrogate makes
  // encodeURIComponent throw a URIError, but Postgres's UTF8 encoding
  // cannot represent one at all, and Node's own string-to-UTF8 boundary
  // silently substitutes U+FFFD for it before a write ever reaches the
  // database (verified live, task-7-report.md: a fixture inserted with
  // '\uD800' in its filename came back from a real create-then-read round
  // trip already containing U+FFFD, never the original surrogate) -- so a
  // test going through the real GET route and a real stored row could
  // never actually exercise encodeURIComponent's throw path; it would pass
  // whether or not the guard existed. Calling buildContentDisposition
  // directly with a raw in-memory string is what makes this non-vacuous.
  it('buildContentDisposition does not throw on a filename containing a lone UTF-16 surrogate', () => {
    const withSurrogate = 'evil\uD800filename.pdf';
    expect(() => buildContentDisposition(withSurrogate)).not.toThrow();
    const result = buildContentDisposition(withSurrogate);
    expect(result).toContain('filename*=UTF-8');
    expect(result).toMatch(/^attachment; filename="[^]*"; filename\*=UTF-8''.*$/);
  });

  // ---- Identity and not-found shape, matching every sibling route -------

  it('rejects an unauthenticated GET (401)', async () => {
    currentSession = null;
    const res = await downloadEvidence(orgA.slug, evidenceNormalId);
    expect(res.status).toBe(401);
  });

  it('GET returns 404 for an evidenceId that does not exist', async () => {
    sessionFor(ownerA);
    const res = await downloadEvidence(orgA.slug, 'evidence-id-does-not-exist');
    expect(res.status).toBe(404);
  });

  it('GET returns 404 for evidence belonging to a different org (O-1)', async () => {
    sessionFor(ownerA);
    const res = await downloadEvidence(orgA.slug, orgBEvidenceId);
    expect(res.status).toBe(404);
  });

  // ---- FR-AUTHZ-02: the DELETE method is gone from the contract, the route answers 404 -------------

  it('FR-AUTHZ-02: DELETE .../evidence/<id> answers 404 and leaves the row and its blob, whatever the evidence is', async () => {
    for (const id of [evidenceForDeleteId, evidenceOnCompletedId, orgBEvidenceId, 'evidence-id-does-not-exist']) {
      sessionFor(ownerA);
      const res = await deleteEvidence(orgA.slug, id);
      expect([id, res.status, await res.json()]).toEqual([id, 404, { error: 'Not found', code: 'not_found' }]);
      currentSession = null;
      expect([id, (await deleteEvidence(orgA.slug, id)).status]).toEqual([id, 404]);
    }
    for (const id of [evidenceForDeleteId, evidenceOnCompletedId, orgBEvidenceId]) {
      expect(await testDb.evidence.count({ where: { id } }), id).toBe(1);
      expect(await testDb.evidenceBlob.count({ where: { evidenceId: id } }), id).toBe(1);
    }
  });
});
