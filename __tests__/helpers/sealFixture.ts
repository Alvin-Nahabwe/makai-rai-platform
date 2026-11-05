import { createHash, randomUUID } from 'node:crypto';
import type { OrgRole } from '@prisma/client';
import type { Stage } from '@/types/record';
import { sealStageReview } from '@/lib/data/seals';
import { ctxFor, type OrgFixture } from './recordFixture';

/**
 * A real seal of a stage review for a document test (DOC-a; test-only): REV-a's `sealStageReview` run as `by` (default the owner),
 * so the stored bytes are the platform's own manifest and `checkSealRows` accepts them. The seal holds the stage's rows as they are
 * when it is called, so a test makes its sealed state first and changes the record after sealing to show it is not read.
 * Document generation compares every seal it uses with the rows it names (M13), which a hand-made manifest cannot pass.
 *
 * `stage`, `contentVersionId`, `decisionVersionIds`, `findingIds` and `derived` are accepted so call sites read as what they
 * set up, and are not used: the content version is the running one (the caller has published it) and the decisions are the stage's.
 */
export async function sealFixture(
  fx: OrgFixture, reviewId: string,
  a: { projectId: string; stage?: Stage; contentVersionId?: string; decisionVersionIds?: string[]; findingIds?: string[]; by?: OrgRole; derived?: unknown },
): Promise<{ id: string; sealNumber: number; fingerprint: string }> {
  const role = a.by ?? 'owner';
  const digest = createHash('sha256').update(randomUUID()).digest('hex');
  const out = await sealStageReview(ctxFor(fx, role), { userId: fx.members[role].userId, role }, { requestId: randomUUID(), projectId: a.projectId, reviewId }, digest);
  return { id: out.value.id, sealNumber: out.value.sealNumber, fingerprint: out.value.fingerprint };
}
