import type { OrgRole } from '@prisma/client';
import { can } from '@/lib/authz/policy';
import { REVIEW_COPY } from '@/lib/review/copy';
import type { StageReviewView } from '@/types/api';

/**
 * The seal step of a stage (design G2 and §8; SRS FR-DOC-09 clause 10), as a pure function. `ask`, `open_and_seal` and
 * `seal` are controls; `waiting` and `sealed` are status lines; `hidden` shows nothing. It reads the role's permissions
 * through `can()` and never names a role, so a change to GRANTS changes what each role sees.
 */
export type SealStepState =
  | { kind: 'hidden' }
  | { kind: 'ask' }
  | { kind: 'waiting'; reviewId: string }
  | { kind: 'open_and_seal' }
  | { kind: 'seal'; reviewId: string }
  | { kind: 'sealed' };

/**
 * The review the step is about (conflict 16, the same rule as `requestSeal`): the newest review with no seal, else the
 * newest review, else none. Newest is the highest number in the stage.
 */
function keyReview(reviews: readonly StageReviewView[]): StageReviewView | null {
  const newest = (rs: readonly StageReviewView[]) => rs.reduce<StageReviewView | null>((a, r) => (a === null || r.numberInStage > a.numberInStage ? r : a), null);
  return newest(reviews.filter((r) => r.latestSeal == null)) ?? newest(reviews);
}

/**
 * What `role` sees for a stage whose reviews are `stageReviews` (every review of one stage, as `listStageReviews` lists
 * them). An archived project shows no seal step (Review Focus 3). A review whose latest seal still matches the stage is
 * "sealed" for every role. A review that is open, or sealed and changed since, or whose latest seal no longer holds together
 * (`latestSealUnreadable`, or bytes that do not match), takes a seal: a role holding `review:seal` sees "Seal this stage";
 * a role holding `review:open` only sees that it waits. A Viewer, holding neither, sees the waiting line while a review
 * is open (clause 10) and nothing for a sealed review that changed since. With no review, a role holding both permissions
 * opens and seals, a role holding `review:open` only asks, and any other role sees nothing.
 */
export function sealStep(role: OrgRole, stageReviews: readonly StageReviewView[], archived: boolean): SealStepState {
  if (archived) return { kind: 'hidden' };
  const canOpen = can(role, 'review:open');
  const canSeal = can(role, 'review:seal');
  const key = keyReview(stageReviews);
  if (key === null) {
    if (canOpen && canSeal) return { kind: 'open_and_seal' };
    return canOpen ? { kind: 'ask' } : { kind: 'hidden' };
  }
  // A view that carries no seal field (`== null` in keyReview, `?? null` here) reads as unsealed, never as a crash: the
  // protected __tests__/integration/decision-pages.test.ts mocks listStageReviews with views of id, number and name only.
  const seal = key.latestSeal ?? null;
  const intact = seal !== null && seal.bytesMatch && !key.latestSealUnreadable;
  if (intact && !key.changedSinceLatestSeal) return { kind: 'sealed' };
  if (canSeal) return { kind: 'seal', reviewId: key.id };
  if (canOpen || seal === null) return { kind: 'waiting', reviewId: key.id };
  return { kind: 'hidden' };
}

/** The words a state puts on the page, in reading order: for the page's first-use term tips (routeTermTips). */
export function sealStepTexts(state: SealStepState): string[] {
  const C = REVIEW_COPY.sealStep;
  switch (state.kind) {
    case 'hidden': return [];
    case 'ask': return [C.ask];
    case 'waiting': return [C.waiting];
    case 'seal': return [C.seal];
    case 'open_and_seal': return [C.openAndSeal];
    case 'sealed': return [C.sealed];
  }
}
