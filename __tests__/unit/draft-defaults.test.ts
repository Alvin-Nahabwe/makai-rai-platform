import { describe, it, expect } from 'vitest';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';
import { draftFromCurrent, EMPTY_DATE, isDraftValue, restoreDraft, toSaveBody } from '@/lib/question/draft';

/**
 * Answer cost, Task 3 (design 2026-11-22 section 2 item 1 and section 8 "Browser drafts and the defaults"): the answer
 * form opens with "Decided by" and "Decided on" filled in, and a browser draft keeps who and when only when the person
 * changed them in it.
 */
const T = { day: '22', month: '11', year: '2026' };
const VIEWER = 'u-me';
const QUESTION = {
  id: 'Q-PP-01', type: 'likert-5', text: 'Q', principle: 'Proportionality', gaps: [], expectedPractice: 'g', whyAsked: 'y',
  reasonPrompt: 'z', evidenceExamples: [], stage: 'pre-processing', moduleId: 'M1', moduleTitle: 'M', order: 0,
} as LoadedQuestion;
const BY_MEMBER: DecisionVersionView = {
  id: 'dv1', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', versionNumber: 1, baseVersionNumber: null,
  content: { contentVersionId: 'c1', semver: '0.0.1-fixture', contentHash: 'h' }, status: 'partly', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: 'Theirs', reasonErased: null,
  decidedBy: { kind: 'member', user: { userId: 'u-m', name: 'Dr Okello', formerMember: false } } as never, declaredDate: '2026-10-12', declaredPrecision: 'day',
  withdrawalCode: null, enteredBy: { userId: 'u-j', name: 'Joseph K.', formerMember: false }, enteredByRole: 'assessor',
  receivedAt: '2026-10-12T07:42:00.000Z', evidence: [],
};
const PANEL: QuestionPanelData = {
  orgSlug: 'acme', projectId: 'p1', projectArchived: false, stage: 'pre-processing', question: QUESTION, runningQuestion: QUESTION,
  position: { index: 0, total: 24, previousId: null, nextId: 'Q-PP-02' }, current: null, historyCount: 0, seals: [],
  reasonCodes: [], members: [{ userId: 'u-m', name: 'Dr Okello' }], viewer: { userId: VIEWER, name: 'Amina N.', role: 'assessor' },
  canWrite: true, canRaiseFinding: true, lastOwnSaveDate: null, openFinding: null, gateAnswer: null,
  contentSemver: '0.0.1-fixture', orgId: 'o1',
};
const withdrawn = { ...PANEL, current: { ...BY_MEMBER, status: 'withdrawn' as const, withdrawalCode: 'duplicate' as const, decidedBy: null, declaredDate: null } };
const changeOf = { ...PANEL, current: BY_MEMBER };
const viewer = { kind: 'member', userId: VIEWER };

describe('answer cost 3: the answer form opens with who and when filled in', () => {
  it('a first answer defaults decidedBy to the viewer and date to today', () => {
    expect(draftFromCurrent(PANEL, T)).toMatchObject({ decidedBy: viewer, date: T, whoWhenChanged: false });
  });

  it('after a withdrawal the same', () => {
    expect(draftFromCurrent(withdrawn, T)).toMatchObject({ status: null, decidedBy: viewer, date: T, whoWhenChanged: false });
  });

  it('a change keeps the current decider, and the date is today', () => {
    const d = draftFromCurrent(changeOf, T);
    expect(d.decidedBy).toEqual({ kind: 'member', userId: 'u-m' });
    expect(d).toMatchObject({ date: T, whoWhenChanged: false, status: 'partly', reason: 'Theirs' });
  });

  it('a change whose version has no decider falls back to the viewer', () => {
    expect(draftFromCurrent({ ...PANEL, current: { ...BY_MEMBER, decidedBy: null } }, T).decidedBy).toEqual(viewer);
  });

  it('a server render (today null) leaves the date empty, for every case', () => {
    for (const p of [PANEL, withdrawn, changeOf]) expect(draftFromCurrent(p, null).date).toEqual(EMPTY_DATE);
  });

  it('the date is a copy, so editing it never changes today or EMPTY_DATE', () => {
    const a = draftFromCurrent(PANEL, T);
    expect(a.date).not.toBe(T);
    expect(draftFromCurrent(PANEL, null).date).not.toBe(EMPTY_DATE);
  });
});

describe('answer cost 3: a stored draft keeps who and when only if the person changed them', () => {
  const stored = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    status: 'done', scopeAnswer: null, optionsInPlace: [], reasonCode: null, reason: 'Typed.', decidedBy: null,
    date: { day: '', month: '', year: '' }, evidenceIds: ['e1'], notUploaded: ['a.pdf'], href: '/old/href', ...over,
  });

  it('restoreDraft of a v0.9.0 draft (decidedBy null, empty date, no whoWhenChanged) applies the defaults and keeps its status and reason', () => {
    const r = restoreDraft(stored(), PANEL, T)!;
    expect(r).toMatchObject({
      status: 'done', reason: 'Typed.', evidenceIds: ['e1'], notUploaded: ['a.pdf'],
      decidedBy: viewer, date: T, whoWhenChanged: false, href: '/orgs/acme/projects/p1/stages/pre-processing/questions/Q-PP-01',
    });
  });

  it('restoreDraft with whoWhenChanged true keeps the stored decider and date, even a date from an earlier day', () => {
    const own = { decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, date: { day: '3', month: '11', year: '2026' }, whoWhenChanged: true };
    expect(restoreDraft(stored(own), PANEL, T)).toMatchObject(own);
  });

  it('restoreDraft with whoWhenChanged false uses the defaults, so the date is today and the stored decider is not trusted', () => {
    const old = { decidedBy: { kind: 'member', userId: 'u-other' }, date: { day: '3', month: '11', year: '2026' }, whoWhenChanged: false };
    expect(restoreDraft(stored(old), PANEL, T)).toMatchObject({ decidedBy: viewer, date: T, whoWhenChanged: false });
    expect(restoreDraft(stored(old), changeOf, T)).toMatchObject({ decidedBy: { kind: 'member', userId: 'u-m' }, date: T });
  });

  it('restoreDraft on a server render (today null) gives an empty date unless the person changed it', () => {
    expect(restoreDraft(stored(), PANEL, null)!.date).toEqual(EMPTY_DATE);
  });

  it('restoreDraft returns null for a value isDraftValue rejects', () => {
    for (const bad of [null, 'x', 7, [], {}, stored({ reason: 5 }), stored({ date: null }), stored({ whoWhenChanged: 'yes' })]) {
      expect(isDraftValue(bad)).toBe(false);
      expect(restoreDraft(bad, PANEL, T)).toBeNull();
    }
  });

  it('isDraftValue accepts a draft without whoWhenChanged and one with a boolean', () => {
    expect(isDraftValue(stored())).toBe(true);
    expect(isDraftValue(stored({ whoWhenChanged: true }))).toBe(true);
  });
});

describe('answer cost 3: the new field never leaves the browser', () => {
  it('toSaveBody does not carry whoWhenChanged', () => {
    const d = { ...draftFromCurrent(PANEL, T), status: 'done' as const };
    expect(Object.keys(toSaveBody(d, PANEL, null))).not.toContain('whoWhenChanged');
  });
});
