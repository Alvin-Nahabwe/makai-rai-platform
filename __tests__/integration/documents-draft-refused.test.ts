import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issueDocument } from '@/lib/data/documents';
import { requestDigest } from '@/lib/data/idempotency';
import * as tenant from '@/lib/data/tenant';
import type { DocumentSnapshot } from '@/lib/documents/resolve';
import { STAGES } from '@/types/record';
import { resetDb, testDb } from '../helpers/db';
// Aliased: the name starts with "use", and react-hooks/rules-of-hooks reads any such call as a React hook.
import { useFixtureContent as publishFixtureContent } from '../helpers/content';
import { addDecision, addProject, addStageReview, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { sealFixture } from '../helpers/sealFixture';

/**
 * Anti-goal 5 at run time: a draft is never stored in `issued_documents`. The type keeps a draft off the issue path (`SealedSnapshot`,
 * `sealed-snapshot-type.test.ts`), but an `as SealedSnapshot` cast gets past a type. So `build` refuses a draft-provenance snapshot
 * itself, before anything is resolved, rendered or written. This file reaches the issue path with a real draft through the one seam
 * there is: the transaction result that carries the snapshot is turned into a draft (provenance and every stage) on its way out of
 * `withOrg`, as a cast in a later caller would hand it over. The seal ids and fingerprints stay, so the seal check still passes and the
 * draft reaches `build`.
 */
vi.mock('@/lib/data/tenant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/data/tenant')>();
  return { ...actual, withOrg: vi.fn(actual.withOrg) };
});

vi.setConfig({ testTimeout: 60_000 });

const TAKEN_AT = '2026-11-19T14:05:09.000Z';

function asDraft(snap: DocumentSnapshot): DocumentSnapshot {
  const draftStage = <S extends DocumentSnapshot['chosen'] | null>(s: S): S => (s === null ? s : {
    ...s, seal: { ...s.seal, kind: 'draft', key: `draft:${s.stage}`, takenAt: TAKEN_AT, openReview: null, lastSealedReview: null },
  }) as S;
  const stages = Object.fromEntries(STAGES.map((st) => [st, draftStage(snap.stages[st])])) as DocumentSnapshot['stages'];
  return { ...snap, provenance: { kind: 'draft', takenAt: TAKEN_AT, omittedAnswers: 0, recordedQuestionWords: new Map() }, chosen: stages[snap.reviewStage]!, stages };
}

let fx: OrgFixture;
let projectId: string;
let ppReview: string;
let ppSeal: string;

beforeEach(async () => {
  await resetDb();
  const { contentVersionId } = await publishFixtureContent('0.0.1-fixture');
  fx = await buildOrg({ label: 'dref' });
  projectId = (await addProject(fx)).id;
  await addDecision(fx, projectId, {
    stage: 'pre-processing', questionId: 'Q-PP-13', contentVersionId, status: 'done',
    decidedBy: { kind: 'member', userId: fx.members.owner.userId }, declaredDate: '2026-10-30',
  });
  ppReview = (await addStageReview(fx, projectId, { stage: 'pre-processing' })).id;
  ppSeal = (await sealFixture(fx, ppReview, { projectId })).id;
});

describe('the issue path and a draft snapshot', () => {
  it('anti-goal 5: issueDocument refuses a draft snapshot cast past the type, by name, and writes no issued_documents row', async () => {
    const real = (await vi.importActual<typeof import('@/lib/data/tenant')>('@/lib/data/tenant')).withOrg;
    vi.mocked(tenant.withOrg).mockImplementation(async (ctx, cb, options) => {
      const out = await real(ctx, cb, options);
      if (out !== null && typeof out === 'object' && 'snap' in out) {
        const read = out as { snap: DocumentSnapshot };
        read.snap = asDraft(read.snap);
      }
      return out;
    });
    const requestId = randomUUID();
    const b = { projectId, reviewId: ppReview, sealId: ppSeal, documentType: 'data_card' as const, typedFields: {} };
    const digest = requestDigest({ path: { id: projectId, reviewId: ppReview }, body: { requestId, documentType: b.documentType, sealId: ppSeal, typedFields: {} } });
    const ctx = ctxFor(fx, 'admin');
    const actor = { userId: fx.members.admin.userId, role: 'admin' as const };
    try {
      await expect(issueDocument(ctx, actor, { ...b, requestId }, digest)).rejects.toMatchObject({ name: 'DraftSnapshotRefused' });
    } finally {
      vi.mocked(tenant.withOrg).mockImplementation(real);
    }
    expect(await testDb.issuedDocument.count()).toBe(0);
    expect(await testDb.issuedDocumentSeal.count()).toBe(0);
  });
});
