import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';
import type { DecisionDraft } from '@/lib/question/draft';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { decode, textOf } from '@/__tests__/helpers/markup';

/**
 * A decider who has left the organisation is on no member list, so the form can name them only from a version that
 * names them: the current version it knows, or the version its answer was opened from (which stays the person's own
 * answer's decider after a newer version replaces it). `departedDeciders` is that rule; the Decided by field and the
 * who and when line read it. The cases prove the function, and, in a static render, what the field and the line are
 * given when handed that decider. They do not prove what a browser shows after a conflict, or that the form hands the
 * decider over: e2e/decision-conflict-saved-claims.spec.ts ("a decider who has left") runs that.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/x' }));

const { departedDeciders, memberDecider } = await import('@/lib/decision/form/departedDecider');
const { panelWithNewest } = await import('@/lib/decision/form/newestVersion');
const { DecisionFields } = await import('@/components/decision/DecisionFields');
const { draftFromCurrent } = await import('@/lib/question/draft');

const F = DECISION_FORM_COPY;
const RUNNING = {
  id: 'Q-PP-01', type: 'likert-5', text: 'Have you checked whether AI is the best approach?', principle: 'Proportionality',
  gaps: [], expectedPractice: 'Good practice.', whyAsked: 'y', reasonPrompt: 'Name the alternatives you compared.',
  evidenceExamples: [], stage: 'pre-processing', moduleId: 'M1', moduleTitle: 'Problem Formulation', order: 0,
} as LoadedQuestion;
const ME = { userId: 'u-me', name: 'Amina N.', role: 'assessor' as const };
/** Left the organisation: on no member list. */
const GONE = { userId: 'u-gone', name: 'Grace A.', formerMember: true };
const ALSO_GONE = { userId: 'u-gone-2', name: 'Peter O.', formerMember: true };
const JOSEPH = { userId: 'u-j', name: 'Joseph K.', formerMember: false };
/** Version 1: entered by the viewer, decided by a person who has since left. */
const V1: DecisionVersionView = {
  id: 'dv1', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', versionNumber: 1, baseVersionNumber: null,
  content: { contentVersionId: 'c1', semver: '0.0.1-fixture', contentHash: 'h1' }, status: 'done', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: 'Mine, version 1', reasonErased: null,
  decidedBy: { kind: 'member', user: GONE }, declaredDate: '2026-10-12', declaredPrecision: 'day',
  withdrawalCode: null, enteredBy: { userId: ME.userId, name: ME.name, formerMember: false }, enteredByRole: 'assessor',
  receivedAt: '2026-10-12T07:42:00.000Z', evidence: [],
};
/** Version 2, saved by someone else: decided by an outside role. */
const V2: DecisionVersionView = {
  ...V1, id: 'dv2', versionNumber: 2, baseVersionNumber: 1, status: 'partly', reason: 'Theirs, version 2',
  decidedBy: { kind: 'outside_role', role: 'supervisor' }, declaredDate: '2026-11-03', enteredBy: JOSEPH, receivedAt: '2026-11-03T09:00:00.000Z',
};
const WITHDRAWN: DecisionVersionView = { ...V2, status: 'withdrawn', withdrawalCode: 'entered_in_error', reason: 'Entered in error.', decidedBy: null, declaredDate: null, declaredPrecision: null };
const PAGE: QuestionPanelData = {
  orgSlug: 'acme', projectId: 'p1', projectArchived: false, stage: 'pre-processing', question: RUNNING, runningQuestion: RUNNING,
  position: { index: 1, total: 24, previousId: 'Q-PP-00', nextId: 'Q-PP-02' }, current: V1, historyCount: 1, seals: [], reasonCodes: [],
  members: [{ userId: JOSEPH.userId, name: JOSEPH.name }], viewer: ME, canWrite: true, canRaiseFinding: true, lastOwnSaveDate: null,
  openFinding: null, gateAnswer: null, contentSemver: '0.0.1-fixture', orgId: 'o1',
};
/** The person's own answer, as the form opened it from version 1: decided by the person who has left, on a typed date. */
const MINE: DecisionDraft = { ...draftFromCurrent(PAGE, null), date: { day: '26', month: '11', year: '2026' } };

const markup = (data: QuestionPanelData, value: DecisionDraft, open: boolean, openedDecider?: { userId: string; name: string } | null): string => renderToStaticMarkup(
  <DecisionFields data={data} value={value} errors={[]} disabled={false} onChange={() => {}} whoWhenOpen={open} onOpenWhoWhen={() => {}} ownVersion openedDecider={openedDecider} />,
);
/** The Decided by field's options as [value, text, selected], read from the markup. */
const deciderOptions = (html: string): Array<[string, string, boolean]> => {
  const select = /<select[^>]*id="decision-decided-by"[\s\S]*?<\/select>/.exec(html)?.[0] ?? '';
  return [...select.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map((m) => [/value="([^"]*)"/.exec(m[1])?.[1] ?? '', decode(m[2]), /\sselected/.test(m[1])]);
};

describe('the member a version names as its decider', () => {
  it('is that member for a decision a member decided, and nobody for an outside role, a withdrawal or no version', () => {
    expect(memberDecider(V1)).toBe(GONE);
    expect(memberDecider(V2)).toBeNull();
    expect(memberDecider(WITHDRAWN)).toBeNull();
    expect(memberDecider(null)).toBeNull();
  });
});

describe('the deciders the form can name who are on no member list', () => {
  it('the current version\'s decider when they have left, as before', () => {
    expect(departedDeciders(PAGE, null)).toEqual([GONE]);
    expect(departedDeciders(PAGE, GONE)).toEqual([GONE]);
  });

  it('nobody when the current version was decided by the viewer, a listed member, an outside role, or is a withdrawal or absent', () => {
    expect(departedDeciders({ ...PAGE, current: { ...V1, decidedBy: { kind: 'member', user: { ...ME, formerMember: false } } } }, null)).toEqual([]);
    expect(departedDeciders({ ...PAGE, current: { ...V1, decidedBy: { kind: 'member', user: JOSEPH } } }, null)).toEqual([]);
    expect(departedDeciders({ ...PAGE, current: V2 }, null)).toEqual([]);
    expect(departedDeciders({ ...PAGE, current: WITHDRAWN }, null)).toEqual([]);
    expect(departedDeciders({ ...PAGE, current: null }, null)).toEqual([]);
  });

  it('the decider of the version the answer was opened from, once a newer version by someone else is the current one', () => {
    expect(departedDeciders(panelWithNewest(PAGE, V2), GONE)).toEqual([GONE]);
    expect(departedDeciders(panelWithNewest(PAGE, WITHDRAWN), GONE)).toEqual([GONE]);
    // and after the page has caught up, when no version it holds names that person
    expect(departedDeciders({ ...PAGE, current: V2 }, GONE)).toEqual([GONE]);
  });

  it('both, the current version\'s first, when two different people who have left decided the two versions', () => {
    const newer = { ...V2, decidedBy: { kind: 'member' as const, user: ALSO_GONE } };
    expect(departedDeciders({ ...PAGE, current: newer }, GONE)).toEqual([ALSO_GONE, GONE]);
  });

  it('not the opened version\'s decider when they are the viewer or still a listed member', () => {
    expect(departedDeciders({ ...PAGE, current: V2 }, { userId: ME.userId, name: ME.name })).toEqual([]);
    expect(departedDeciders({ ...PAGE, current: V2 }, JOSEPH)).toEqual([]);
  });
});

describe('what the Decided by field and the who and when line are given', () => {
  it('the person\'s own decider stays the chosen option, labelled a former member, over a newer version decided by someone else', () => {
    const options = deciderOptions(markup(panelWithNewest(PAGE, V2), MINE, true, GONE));
    expect(options.filter(([, , selected]) => selected)).toEqual([[`member:${GONE.userId}`, F.formerMember(GONE.name), true]]);
    expect(options.filter(([value]) => value === `member:${GONE.userId}`)).toHaveLength(1);
  });

  it('the who and when line names them, with the label, when the newer version is a withdrawal and the fields are closed', () => {
    const text = decode(textOf(markup(panelWithNewest(PAGE, WITHDRAWN), MINE, false, GONE)));
    expect(text).toContain(`Decided by ${F.formerMember(GONE.name)}, 26 Nov 2026`);
  });
});
