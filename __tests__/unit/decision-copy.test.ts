import { describe, expect, it } from 'vitest';
import type { DecisionVersionView } from '@/types/api';
import {
  deciderLabel, FINDING_NOTE, M11, OUTSIDE_ROLE_LABELS, problemSummary, REASON_HELP, reasonCount, savedMessage, SCOPE_OPTIONS,
  STATUS_OPTIONS, WITHDRAW_COPY, WITHDRAWAL_CODE_LABELS,
} from '@/lib/decision/copy';

const ME = 'user-me';

/** A `DecisionVersionView` literal with the fields a test does not care about filled in. */
function view(over: Partial<DecisionVersionView>): DecisionVersionView {
  return {
    id: 'v-1', projectId: 'p-1', stage: 'pre-processing', questionId: 'Q-PP-01', versionNumber: 1, baseVersionNumber: null,
    content: { contentVersionId: 'fv_fixture_0_0_1', semver: '0.0.1-fixture', contentHash: 'h' }, status: 'done', scopeAnswer: null,
    optionsInPlace: [], reasonCode: null, reason: 'r', reasonErased: null, decidedBy: { kind: 'member', user: { userId: ME, name: 'Amina K.', formerMember: false } },
    declaredDate: '2026-10-12', declaredPrecision: 'day', withdrawalCode: null,
    enteredBy: { userId: ME, name: 'Amina K.', formerMember: false }, enteredByRole: 'assessor',
    receivedAt: '2026-10-30T07:42:00.000Z', evidence: [], ...over,
  };
}

describe('lib/decision/copy.ts', () => {
  it('UX-09: four statuses in order with the 7.5.6 helper texts and the finding note', () => {
    expect(STATUS_OPTIONS).toEqual([
      { value: 'done', label: 'Done', help: 'The expected practice is in place.' },
      { value: 'partly', label: 'Partly', help: 'Some of the expected practice is in place.' },
      { value: 'not_yet', label: 'Not yet', help: 'The expected practice is not in place yet.' },
      { value: 'not_applicable', label: 'Not applicable', help: 'The practice does not apply to this project. Say why in the reason.' },
    ]);
    expect(FINDING_NOTE).toBe("Saving 'Partly' or 'Not yet' keeps a finding open for this question, or opens one.");
  });

  it('FR-DEC-02: the three scope answers in order with the 7.5.6 helper texts', () => {
    expect(SCOPE_OPTIONS).toEqual([
      { value: 'yes', label: 'Yes', help: 'It contains sensitive or personal information.' },
      { value: 'no', label: 'No', help: 'It does not.' },
      { value: 'not_sure', label: 'Not sure', help: 'We do not know yet. The two personal-data questions stay open.' },
    ]);
  });

  it('UX-12: the reason helper and the live count in text', () => {
    expect(REASON_HELP).toBe('Say what is in place, where it is recorded, and what is missing.');
    expect(reasonCount(212)).toBe('212 / 4,000 characters');
    expect(reasonCount(4001)).toBe('4,001 / 4,000 characters');
  });

  it('UX-11 M-03: the saved confirmation names who decided and who entered', () => {
    expect(savedMessage(view({ versionNumber: 1, decidedBy: { kind: 'outside_role', role: 'ethics_committee' } }), '10:42 EAT', ME))
      .toBe('Saved as version 1 at 10:42 EAT. Decided by: Ethics committee. Entered by: you.');
    expect(Object.values(OUTSIDE_ROLE_LABELS)).toEqual(['Principal investigator', 'Supervisor', 'Ethics committee',
      'Data-access committee', 'Institutional data-protection officer', 'Funder', 'Other']);
    expect(deciderLabel({ kind: 'outside_role', role: 'principal_investigator' }, ME, 'record')).toBe('Principal investigator (outside role)');
    expect(deciderLabel({ kind: 'member', user: { userId: 'u2', name: 'Grace A.', formerMember: true } }, ME, 'record')).toBe('Grace A. (former member)');
    expect(deciderLabel({ kind: 'member', user: { userId: ME, name: 'Amina K.', formerMember: false } }, ME, 'confirmation')).toBe('you');
    expect(deciderLabel({ kind: 'member', user: { userId: 'u2', name: 'Grace A.', formerMember: false } }, ME, 'confirmation')).toBe('Grace A.');
  });

  it('M-11: the summary counts the problems and keeps the answer', () => {
    expect(problemSummary(1)).toBe('There is a problem with this decision. Your answer is kept.');
    expect(problemSummary(2)).toBe('There are 2 problems with this decision. Your answer is kept.');
    expect(M11.webAddress).toBe('Enter a web address that starts with http:// or https://.');
    expect([M11.monthDays(2, 2028), M11.monthDays(4, 2026), M11.reasonTooLong(12345), M11.unchanged(2)]).toEqual([
      'February has 29 days.', 'April has 30 days.', 'The reason is 12,345 characters. The limit is 4,000.',
      'This is the same as version 2. Change something before saving, or keep version 2.',
    ]);
  });

  it('UX-29 UX-42 FR-DEC-08: the withdrawal confirmation names the object and the consequence and repeats the action', () => {
    expect(WITHDRAW_COPY.trigger).toBe('Withdraw this decision');
    expect(WITHDRAW_COPY.action).toBe('Withdraw decision');
    expect(WITHDRAW_COPY.objectName(2, 'Q-PP-01')).toBe('Version 2 of the decision on Q-PP-01');
    expect(WITHDRAW_COPY.consequence).toBe('The question returns to "no decision". Every version stays in the history.');
    expect(Object.values(WITHDRAWAL_CODE_LABELS)).toEqual(['Entered in error', 'Wrong project', 'Duplicate', 'Test entry']);
  });
});
