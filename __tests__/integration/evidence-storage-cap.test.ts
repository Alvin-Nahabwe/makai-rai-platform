import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { resetDb, testDb } from '../helpers/db';
import { addIssuedDocument, addProject, addSealRow, addStageReview, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { createFileEvidence } from '@/lib/data/evidence';
import { requestDigest } from '@/lib/data/idempotency';
import { storageLimits } from '@/lib/evidence/storageCap';
import { STORAGE_FULL_TEXT } from '@/lib/evidence/copy';

// NFR-REL-09: a multipart body of an exact 10 MiB file exceeds MAX_BYTES and the 10 MB proxy buffer, so a test of the
// cap uses files just under it, or its 413 would be the size gate's.
const NEAR_10_MIB = 10 * 1024 * 1024 - 4096;

let fx: OrgFixture;
let projectId: string;

/** A PDF of `size` bytes whose content differs by `salt`, so two uploads never share a hash. */
function pdf(size: number, salt: number): Buffer {
  const b = Buffer.alloc(size, salt);
  b.write('%PDF-1.4\n', 0, 'latin1');
  return b;
}

async function uploadTo(f: OrgFixture, pid: string, role: OrgRole, bytes: Buffer) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fileName = `f-${sha256.slice(0, 8)}.pdf`;
  const actor = { userId: f.members[role].userId, role };
  return createFileEvidence(ctxFor(f, role), actor, { projectId: pid, fileName, bytes, requestId: randomUUID() },
    requestDigest({ path: { id: pid }, body: { kind: 'file', fileName, sha256 } }));
}
const upload = (f: OrgFixture, role: OrgRole, bytes: Buffer) => uploadTo(f, projectId, role, bytes);
const counts = async () => [await testDb.evidence.count(), await testDb.evidenceBlob.count()];

beforeEach(async () => {
  await resetDb();
  vi.unstubAllEnvs();
  fx = await buildOrg();
  projectId = (await addProject(fx)).id;
});

/** The same account as a member of `fxB`'s organisation too (the contract's buildOrg has no option for a shared account). */
async function alsoMemberOf(a: OrgFixture, role: OrgRole, b: OrgFixture): Promise<OrgFixture> {
  const account = a.members[role];
  await testDb.membership.create({ data: { orgId: b.org.id, userId: account.userId, role } });
  return { ...b, members: { ...b.members, [role]: { ...account, role, orgId: b.org.id, orgSlug: b.org.slug } } };
}

describe('storage caps (NFR-REL-09)', () => {
  it('NFR-REL-09: the defaults are 1 GiB and 200 MiB', () => {
    expect(storageLimits({})).toEqual({ orgBytes: 1073741824, accountBytesPerDay: 209715200 });
    expect(storageLimits({ MAKRAI_ORG_STORAGE_CAP_BYTES: '0', MAKRAI_ACCOUNT_UPLOAD_BYTES_PER_DAY: 'abc' }))
      .toEqual({ orgBytes: 1073741824, accountBytesPerDay: 209715200 });
    expect(storageLimits({ MAKRAI_ORG_STORAGE_CAP_BYTES: '1000000' }).orgBytes).toBe(1000000);
  });

  it('NFR-REL-09: with the cap at 20 MiB the third near-10 MiB upload answers 413 and writes nothing', async () => {
    vi.stubEnv('MAKRAI_ORG_STORAGE_CAP_BYTES', String(20 * 1024 * 1024));
    for (let i = 0; i < 2; i++) await expect(upload(fx, 'assessor', pdf(NEAR_10_MIB, i))).resolves.toMatchObject({ replayed: false });
    const before = await counts();
    await expect(upload(fx, 'assessor', pdf(NEAR_10_MIB, 3))).rejects.toMatchObject({
      status: 413, code: 'storage_full', message: STORAGE_FULL_TEXT,
    });
    expect(await counts()).toEqual(before);
  });

  it('NFR-REL-09: issued document bytes count, and the next upload is refused', async () => {
    vi.stubEnv('MAKRAI_ORG_STORAGE_CAP_BYTES', String(20 * 1024 * 1024));
    const review = await addStageReview(fx, projectId, { stage: 'pre-processing' });
    const seal = await addSealRow(fx, review.id);
    await addIssuedDocument(fx, review.id, { documentType: 'data_card', sealIds: [seal.id], pdf: Buffer.alloc(15 * 1024 * 1024) });
    await expect(upload(fx, 'assessor', pdf(NEAR_10_MIB, 1))).rejects.toMatchObject({ code: 'storage_full' });
  });

  it('NFR-REL-09: an account may upload 200 MiB a day; another account of the organisation still can', async () => {
    vi.stubEnv('MAKRAI_ACCOUNT_UPLOAD_BYTES_PER_DAY', String(20 * 1024 * 1024));
    await upload(fx, 'assessor', pdf(NEAR_10_MIB, 1));
    await upload(fx, 'assessor', pdf(NEAR_10_MIB, 2));
    await expect(upload(fx, 'assessor', pdf(NEAR_10_MIB, 3))).rejects.toMatchObject({ code: 'storage_full' });
    await expect(upload(fx, 'admin', pdf(NEAR_10_MIB, 4))).resolves.toMatchObject({ replayed: false });
  });

  it('NFR-REL-09: three concurrent uploads under a 20 MiB cap store exactly two', async () => {
    vi.stubEnv('MAKRAI_ORG_STORAGE_CAP_BYTES', String(20 * 1024 * 1024));
    const r = await Promise.allSettled([1, 2, 3].map((i) => upload(fx, 'assessor', pdf(NEAR_10_MIB, i))));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
    expect(await testDb.evidence.count()).toBe(2);
  });

  it('NFR-REL-09 (contract Q12, owner question B18): a member of two organisations has a separate daily sum in each', async () => {
    vi.stubEnv('MAKRAI_ACCOUNT_UPLOAD_BYTES_PER_DAY', String(20 * 1024 * 1024));
    const fxB = await alsoMemberOf(fx, 'assessor', await buildOrg({ label: 'b' }));
    const projectB = (await addProject(fxB)).id;
    await upload(fx, 'assessor', pdf(NEAR_10_MIB, 1));
    await upload(fx, 'assessor', pdf(NEAR_10_MIB, 2));
    await expect(upload(fx, 'assessor', pdf(NEAR_10_MIB, 3))).rejects.toMatchObject({ code: 'storage_full' });
    await expect(uploadTo(fxB, projectB, 'assessor', pdf(NEAR_10_MIB, 4))).resolves.toMatchObject({ replayed: false });
  });
});
