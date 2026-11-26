import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { FINDING_NOTE } from '@/lib/decision/copy';
import { decode, textOf } from '@/__tests__/helpers/markup';

/**
 * A save's reply can name a version the page does not hold yet (a conflict's current version, the version the save made);
 * `panelWithNewest` gives the form the page's panel with that version as its current one. These cases prove two things:
 * the function (its current version is never older than the page's or the named one), and what the fields and the
 * consequence line state when they are handed that panel, in a static render. What the reply cannot say (whether the
 * question has an open finding now) is not stated while the page is behind.
 *
 * They do not prove that every statement of the running form reads that panel: a static render of two readers cannot.
 * e2e/decision-conflict-saved-claims.spec.ts runs the form in a browser, for the states it lists. Nothing here covers a
 * version the form knows only from the page (the function is handed reply-named versions only).
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/x' }));

const { panelWithNewest } = await import('@/lib/decision/form/newestVersion');
const { consequenceOf } = await import('@/components/decision/DecisionForm');
const { DecisionFields } = await import('@/components/decision/DecisionFields');
const { draftFromCurrent } = await import('@/lib/question/draft');

const F = DECISION_FORM_COPY;
const C = F.consequence;

const RUNNING = {
  id: 'Q-PP-01', type: 'likert-5', text: 'Have you checked whether AI is the best approach?', principle: 'Proportionality',
  gaps: [], expectedPractice: 'Good practice.', whyAsked: 'y', reasonPrompt: 'Name the alternatives you compared.',
  evidenceExamples: [], stage: 'pre-processing', moduleId: 'M1', moduleTitle: 'Problem Formulation', order: 0,
} as LoadedQuestion;
/** The wording version 1 was answered against, older than the running content's. */
const EARLIER = { ...RUNNING, text: 'Did you check whether AI is the best approach?' } as LoadedQuestion;
const ME = { userId: 'u-me', name: 'Amina N.', role: 'assessor' as const };
const V1: DecisionVersionView = {
  id: 'dv1', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', versionNumber: 1, baseVersionNumber: null,
  content: { contentVersionId: 'c0', semver: '0.0.0-earlier', contentHash: 'h0' }, status: 'done', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: 'Mine, version 1', reasonErased: null,
  decidedBy: { kind: 'member', user: { userId: ME.userId, name: ME.name, formerMember: false } }, declaredDate: '2026-10-12', declaredPrecision: 'day',
  withdrawalCode: null, enteredBy: { userId: ME.userId, name: ME.name, formerMember: false }, enteredByRole: 'assessor',
  receivedAt: '2026-10-12T07:42:00.000Z', evidence: [],
};
/** Version 2, saved by someone else under the running content: another answer, decider and date. */
const V2: DecisionVersionView = {
  ...V1, id: 'dv2', versionNumber: 2, baseVersionNumber: 1, content: { contentVersionId: 'c1', semver: '0.0.1-fixture', contentHash: 'h1' },
  status: 'partly', reason: 'Theirs, version 2', decidedBy: { kind: 'outside_role', role: 'supervisor' }, declaredDate: '2026-11-03',
  enteredBy: { userId: 'u-j', name: 'Joseph K.', formerMember: false }, receivedAt: '2026-11-03T09:00:00.000Z',
};
const WITHDRAWN: DecisionVersionView = { ...V2, status: 'withdrawn', withdrawalCode: 'entered_in_error', reason: 'Entered in error.', decidedBy: null, declaredDate: null, declaredPrecision: null };
const PAGE: QuestionPanelData = {
  orgSlug: 'acme', projectId: 'p1', projectArchived: false, stage: 'pre-processing', question: EARLIER, runningQuestion: RUNNING,
  position: { index: 1, total: 24, previousId: 'Q-PP-00', nextId: 'Q-PP-02' }, current: V1, historyCount: 1, seals: [], reasonCodes: [],
  members: [{ userId: 'u-j', name: 'Joseph K.' }], viewer: ME, canWrite: true, canRaiseFinding: true, lastOwnSaveDate: '2026-10-12',
  openFinding: null, gateAnswer: null, contentSemver: '0.0.1-fixture', orgId: 'o1',
};
const fields = (data: QuestionPanelData, ownVersion = false): string => decode(textOf(renderToStaticMarkup(
  <DecisionFields data={data} value={draftFromCurrent(data, null)} errors={[]} disabled={false} onChange={() => {}} whoWhenOpen onOpenWhoWhen={() => {}} ownVersion={ownVersion} />,
)));

describe('the panel the form reads: the page\'s, or the newest version a reply named while the page is older', () => {
  it('is the page\'s own panel, the same object, when no version was named or the named one is not newer', () => {
    expect(panelWithNewest(PAGE, null)).toBe(PAGE);
    expect(panelWithNewest(PAGE, V1)).toBe(PAGE);
    const at2 = { ...PAGE, current: V2 };
    expect(panelWithNewest(at2, V2)).toBe(at2);
    // data older than the version a reply named, arriving late, does not win either way round
    expect(panelWithNewest(at2, V1)).toBe(at2);
    expect(panelWithNewest({ ...PAGE, current: null }, null).current).toBeNull();
  });

  it('never holds an older current version than the page\'s or the named one', () => {
    const versions = [null, V1, V2, { ...V2, id: 'dv3', versionNumber: 3 }];
    for (const onPage of versions) for (const named of versions) {
      const n = panelWithNewest({ ...PAGE, current: onPage }, named).current?.versionNumber ?? 0;
      expect(n).toBe(Math.max(onPage?.versionNumber ?? 0, named?.versionNumber ?? 0));
    }
  });

  it('takes the named version as current when it is newer, a first answer included, and leaves the rest of the page\'s panel as it was', () => {
    const known = panelWithNewest(PAGE, V2);
    expect(known.current).toBe(V2);
    expect(known.members).toBe(PAGE.members);
    expect(known.viewer).toBe(PAGE.viewer);
    expect(known.reasonCodes).toBe(PAGE.reasonCodes);
    expect(panelWithNewest({ ...PAGE, current: null, question: RUNNING, lastOwnSaveDate: null }, V2).current).toBe(V2);
  });

  it('words the question as the named version was answered: the running wording under the running content and for a withdrawal', () => {
    expect(panelWithNewest(PAGE, V2).question).toBe(RUNNING);
    expect(panelWithNewest(PAGE, WITHDRAWN).question).toBe(RUNNING);
    // a decision under content this page does not hold: the browser cannot load that wording, so the page's stays
    expect(panelWithNewest(PAGE, { ...V2, content: { ...V2.content, semver: '9.9.9' } }).question).toBe(EARLIER);
  });

  it('"my last decision" is the named version\'s date only when the viewer entered it and it is a decision', () => {
    expect(panelWithNewest(PAGE, V2).lastOwnSaveDate).toBe('2026-10-12');
    expect(panelWithNewest(PAGE, { ...V2, enteredBy: V1.enteredBy }).lastOwnSaveDate).toBe('2026-11-03');
    expect(panelWithNewest(PAGE, { ...WITHDRAWN, enteredBy: V1.enteredBy }).lastOwnSaveDate).toBe('2026-10-12');
  });
});

describe('what the form states from that panel', () => {
  it('the date hint and the "Same date as the current decision" shortcut name the newer version\'s date, not the page\'s', () => {
    const text = fields(panelWithNewest(PAGE, V2));
    expect(text).toContain(F.lastDecidedOn('3 Nov 2026'));
    expect(text).toContain(F.sameAsCurrent('3 Nov 2026'));
    expect(text).not.toContain(F.sameAsCurrent('12 Oct 2026'));
    expect(text).not.toContain(F.lastDecidedOn('12 Oct 2026'));
    // the person's own last decision is still version 1: version 2 was entered by someone else
    expect(text).toContain(F.sameAsMyLast('12 Oct 2026'));
  });

  it('a newer version that is a withdrawal: no note that the form shows the current decision, and no "last decided" date', () => {
    const text = fields(panelWithNewest(PAGE, WITHDRAWN));
    expect(text).not.toContain(F.startingNote);
    expect(text).not.toContain('Last decided on');
    expect(text).not.toContain(F.sameAsCurrent('12 Oct 2026'));
    // the control: the page's own version 1 does show them
    expect(fields(PAGE)).toContain(F.startingNote);
  });

  it('the consequence line counts from the newer version and says nothing about a finding the page cannot know', () => {
    const known = panelWithNewest(PAGE, V2);
    const mine = { ...draftFromCurrent(PAGE, null), reason: 'Mine' };
    // the page's finding state is version 1's: with the page behind, no sentence reads it
    const behind = consequenceOf(mine, known, 2, true);
    expect(behind.text).toBe(C.version(3));
    expect(behind.finding).toBe(false);
    expect(behind.tips).toEqual([]);
    // the form drawn from the newer version itself: nothing differs, so there is no line at all
    expect(consequenceOf(draftFromCurrent(known, null), known, 2, true).text).toBe('');
    // with the page up to date the sentence is back
    expect(consequenceOf(mine, { ...PAGE, current: V2, openFinding: { findingId: 'f1' } }, 2).text).toBe(`${C.closesNot('Done')} ${C.version(3)}`);
  });

  it('the sentences that read no finding state stay while the page is behind: no status chosen yet, and the personal data answer', () => {
    const afterWithdrawal = panelWithNewest(PAGE, WITHDRAWN);
    const empty = consequenceOf(draftFromCurrent(afterWithdrawal, null), afterWithdrawal, 2, true);
    expect(empty.text).toBe(`${FINDING_NOTE} ${C.version(3)}`);
    expect(empty.finding).toBe(true);
    const gate = { ...PAGE, question: { ...RUNNING, type: 'gate' } as LoadedQuestion, current: null };
    expect(consequenceOf({ ...draftFromCurrent(gate, null), scopeAnswer: 'no' }, gate, null, true).text).toBe(`${C.scope.no} ${C.version(1)}`);
  });
});
