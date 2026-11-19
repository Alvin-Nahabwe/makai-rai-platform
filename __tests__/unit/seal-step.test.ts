import { describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { GRANTS, can } from '@/lib/authz/policy';
import { sealStep, sealStepTexts, type SealStepState } from '@/lib/review/sealStep';
import { REVIEW_COPY } from '@/lib/review/copy';
import type { SealView, StageReviewView } from '@/types/api';

/**
 * Design G2 and SRS FR-DOC-09 clause 10: what the seal step of a stage shows each role, as a pure function of the role,
 * the stage's reviews and whether the project is archived. The key review is the newest with no seal, else the newest.
 */

const ROLES = Object.keys(GRANTS) as OrgRole[];

const SEAL: SealView = {
  id: 's1', reviewId: 'r1', sealNumber: 1, fingerprint: 'a'.repeat(64), sealedBy: { userId: 'u1', name: 'Grace A.', formerMember: false },
  sealedByRole: 'reviewer', sealedAt: '2026-11-02T07:42:00.000Z', contentSemver: '0.0.1-fixture', bytesMatch: true,
};
const review = (n: number, over: Partial<StageReviewView> = {}): StageReviewView => ({
  id: `r${n}`, projectId: 'p1', stage: 'pre-processing', numberInStage: n, name: `Pre-processing review ${n}`, preparedFor: null,
  openedBy: { userId: 'u2', name: 'Amina N.', formerMember: false }, openedAt: '2026-10-30T08:00:00.000Z',
  latestSeal: null, changedSinceLatestSeal: false, changed: null, preparedForErased: null, latestSealUnreadable: false, ...over,
});
const sealed = (n: number) => review(n, { latestSeal: { ...SEAL, id: `s${n}`, reviewId: `r${n}` } });
const sealedChanged = (n: number) => review(n, {
  latestSeal: { ...SEAL, id: `s${n}`, reviewId: `r${n}` }, changedSinceLatestSeal: true,
  changed: { sealNumber: 1, changedQuestions: ['Q-PP-01'], changedFindings: [] },
});

/**
 * The five columns of the design's table (design G2, §8), as the controller's rulings amend the brief's: an archived
 * project shows no seal step at all, whatever its reviews (Review Focus 3), so the archived column is hidden throughout.
 */
const COLUMNS: Record<string, { reviews: StageReviewView[]; archived: boolean }> = {
  none: { reviews: [], archived: false },
  open: { reviews: [review(1)], archived: false },
  sealedUnchanged: { reviews: [sealed(1)], archived: false },
  sealedChanged: { reviews: [sealedChanged(1)], archived: false },
  archivedNone: { reviews: [], archived: true },
  archivedOpen: { reviews: [review(1)], archived: true },
  archivedSealed: { reviews: [sealed(1)], archived: true },
  archivedSealedChanged: { reviews: [sealedChanged(1)], archived: true },
};

const TABLE: Record<OrgRole, Record<keyof typeof COLUMNS, SealStepState>> = {
  assessor: {
    none: { kind: 'ask' }, open: { kind: 'waiting', reviewId: 'r1' }, sealedUnchanged: { kind: 'sealed' }, sealedChanged: { kind: 'waiting', reviewId: 'r1' },
    archivedNone: { kind: 'hidden' }, archivedOpen: { kind: 'hidden' }, archivedSealed: { kind: 'hidden' }, archivedSealedChanged: { kind: 'hidden' },
  },
  reviewer: {
    none: { kind: 'hidden' }, open: { kind: 'seal', reviewId: 'r1' }, sealedUnchanged: { kind: 'sealed' }, sealedChanged: { kind: 'seal', reviewId: 'r1' },
    archivedNone: { kind: 'hidden' }, archivedOpen: { kind: 'hidden' }, archivedSealed: { kind: 'hidden' }, archivedSealedChanged: { kind: 'hidden' },
  },
  owner: {
    none: { kind: 'open_and_seal' }, open: { kind: 'seal', reviewId: 'r1' }, sealedUnchanged: { kind: 'sealed' }, sealedChanged: { kind: 'seal', reviewId: 'r1' },
    archivedNone: { kind: 'hidden' }, archivedOpen: { kind: 'hidden' }, archivedSealed: { kind: 'hidden' }, archivedSealedChanged: { kind: 'hidden' },
  },
  admin: {
    none: { kind: 'open_and_seal' }, open: { kind: 'seal', reviewId: 'r1' }, sealedUnchanged: { kind: 'sealed' }, sealedChanged: { kind: 'seal', reviewId: 'r1' },
    archivedNone: { kind: 'hidden' }, archivedOpen: { kind: 'hidden' }, archivedSealed: { kind: 'hidden' }, archivedSealedChanged: { kind: 'hidden' },
  },
  // SRS FR-DOC-09 clause 10 (the controller's ruling, over the brief's table): a Viewer sees the status line, and only the
  // line, while a review is open.
  viewer: {
    none: { kind: 'hidden' }, open: { kind: 'waiting', reviewId: 'r1' }, sealedUnchanged: { kind: 'sealed' }, sealedChanged: { kind: 'hidden' },
    archivedNone: { kind: 'hidden' }, archivedOpen: { kind: 'hidden' }, archivedSealed: { kind: 'hidden' }, archivedSealedChanged: { kind: 'hidden' },
  },
};

/** The states that put a control on the page, and the permission each control's request or link needs. */
const CONTROL_NEEDS: Partial<Record<SealStepState['kind'], Array<'review:open' | 'review:seal'>>> = {
  ask: ['review:open'], open_and_seal: ['review:open', 'review:seal'], seal: ['review:seal'],
};

describe('the seal step (design G2, FR-DOC-09 clause 10)', () => {
  it('anti-goal 4: every state shown to a role is one it can act on, for every role in GRANTS × the five states', () => {
    expect(ROLES.sort()).toEqual(['admin', 'assessor', 'owner', 'reviewer', 'viewer']);
    for (const role of ROLES) {
      for (const [column, c] of Object.entries(COLUMNS)) {
        const s = sealStep(role, c.reviews, c.archived);
        const needs = CONTROL_NEEDS[s.kind] ?? [];
        // A control only for a role holding every permission its request or link needs.
        expect({ role, column, kind: s.kind, usable: needs.every((a) => can(role, a)) }).toEqual({ role, column, kind: s.kind, usable: true });
        // "waiting" says an Owner, Admin or Reviewer will seal: a role that can seal is shown its seal action instead.
        if (s.kind === 'waiting') expect({ role, column, canSeal: can(role, 'review:seal') }).toEqual({ role, column, canSeal: false });
        // A role holding neither permission sees a status line at most.
        if (!can(role, 'review:open') && !can(role, 'review:seal')) expect(['hidden', 'waiting', 'sealed']).toContain(s.kind);
      }
    }
  });

  it('the table, cell by cell', () => {
    for (const role of ROLES) {
      for (const [column, c] of Object.entries(COLUMNS)) {
        expect({ role, column, state: sealStep(role, c.reviews, c.archived) }).toEqual({ role, column, state: TABLE[role][column] });
      }
    }
  });

  it('conflict 16: the key review is the newest with no seal, else the newest; an unsealed review 1 beside a sealed review 2 is the open one', () => {
    expect(sealStep('assessor', [review(1), sealed(2)], false)).toEqual({ kind: 'waiting', reviewId: 'r1' });
    expect(sealStep('reviewer', [sealed(2), review(1)], false)).toEqual({ kind: 'seal', reviewId: 'r1' });
    expect(sealStep('reviewer', [review(1), review(3), sealed(2)], false)).toEqual({ kind: 'seal', reviewId: 'r3' });
    expect(sealStep('owner', [sealed(1), sealedChanged(2)], false)).toEqual({ kind: 'seal', reviewId: 'r2' });
    expect(sealStep('owner', [sealedChanged(1), sealed(2)], false)).toEqual({ kind: 'sealed' });
  });

  it('a latest seal that no longer holds together is not "sealed, unchanged": it can be sealed again', () => {
    expect(sealStep('reviewer', [review(1, { latestSeal: SEAL, latestSealUnreadable: true })], false)).toEqual({ kind: 'seal', reviewId: 'r1' });
    expect(sealStep('reviewer', [review(1, { latestSeal: { ...SEAL, bytesMatch: false } })], false)).toEqual({ kind: 'seal', reviewId: 'r1' });
    expect(sealStep('assessor', [review(1, { latestSeal: SEAL, latestSealUnreadable: true })], false)).toEqual({ kind: 'waiting', reviewId: 'r1' });
  });

  it('G2: each state reads the design\'s words, verbatim; hidden reads nothing', () => {
    const C = REVIEW_COPY.sealStep;
    expect(C.ask).toBe('Ask a reviewer to seal this stage');
    expect(C.waiting).toBe('Review opened · waiting for an Owner, Admin or Reviewer to seal');
    expect(C.seal).toBe('Seal this stage');
    expect(C.openAndSeal).toBe('Open and seal this stage');
    expect(sealStepTexts({ kind: 'hidden' })).toEqual([]);
    expect(sealStepTexts({ kind: 'ask' })).toEqual([C.ask]);
    expect(sealStepTexts({ kind: 'waiting', reviewId: 'r1' })).toEqual([C.waiting]);
    expect(sealStepTexts({ kind: 'seal', reviewId: 'r1' })).toEqual([C.seal]);
    expect(sealStepTexts({ kind: 'open_and_seal' })).toEqual([C.openAndSeal]);
    expect(sealStepTexts({ kind: 'sealed' })).toEqual([C.sealed]);
  });
});
