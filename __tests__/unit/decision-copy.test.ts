import { describe, expect, it } from 'vitest';
import type { DecisionVersionView } from '@/types/api';
import {
  DECISION_COPY, deciderLabel, FINDING_NOTE, M11, OUTSIDE_ROLE_LABELS, problemSummary, REASON_HELP, reasonCount, REQUEST_MESSAGES, savedLine,
  countsAs, savedMessage, SCOPE_OPTIONS, STATUS_OPTIONS, WITHDRAW_COPY, WITHDRAWAL_CODE_LABELS, WITHDRAWAL_CODES,
} from '@/lib/decision/copy';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { DECISION_OUTCOME_COPY } from '@/lib/decision/outcome/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import { TERM_DONE, TERM_NOT_APPLICABLE, TERM_NOT_YET, TERM_PARTLY, TERM_PERSONAL_DATA_QUESTION_SCOPE_QUESTION } from '@/lib/vocabulary/terms';

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
      { value: 'done', label: 'Done', help: 'This is in place.' },
      { value: 'partly', label: 'Partly', help: 'Some of it is in place, but not all of it.' },
      { value: 'not_yet', label: 'Not yet', help: 'It is not in place yet.' },
      { value: 'not_applicable', label: 'Not applicable', help: 'It does not apply to this project. Say why in the reason.' },
    ]);
    // plan line 926: the help sentences are the vocabulary's own definitions, character for character
    expect(STATUS_OPTIONS.map((o) => o.help)).toEqual([TERM_DONE, TERM_PARTLY, TERM_NOT_YET, TERM_NOT_APPLICABLE].map((t) => t.definition));
    expect(FINDING_NOTE).toBe('If you choose Partly or Not yet, a finding is raised for this question (or stays open).');
  });

  it('countsAs names the generic word an answer counts as', () => {
    expect(countsAs('Done')).toBe('Counts as Done');
    expect(countsAs('Not applicable')).toBe('Counts as Not applicable');
  });

  it('FR-DEC-02: the three scope answers in order with the 7.5.6 helper texts', () => {
    expect(SCOPE_OPTIONS).toEqual([
      { value: 'yes', label: 'Yes', help: 'The data includes personal or sensitive information.' },
      { value: 'no', label: 'No', help: 'It does not.' },
      { value: 'not_sure', label: 'Not sure', help: 'We do not know yet. The questions about consent and anonymisation still apply.' },
    ]);
  });

  it('UX-12: the reason helper and the live count in text', () => {
    expect(REASON_HELP).toBe('Say what is in place, where it is recorded, and what is missing.');
    expect(reasonCount(212)).toBe('212 / 4,000 characters');
    expect(reasonCount(4001)).toBe('4,001 / 4,000 characters');
  });

  it('UX-11 M-03: the saved confirmation names who decided and who entered', () => {
    expect(savedMessage(view({ versionNumber: 1, decidedBy: { kind: 'outside_role', role: 'ethics_committee' } }), '10:42 EAT', ME))
      .toBe('Saved at 10:42 EAT as version 1. Decided by: Ethics committee.');
    expect(savedLine('10:42 EAT', 2, null)).toBe('Saved at 10:42 EAT as version 2.');
    expect(Object.values(OUTSIDE_ROLE_LABELS)).toEqual(['Principal investigator', 'Supervisor', 'Ethics committee',
      'Data-access committee', 'Institutional data-protection officer', 'Funder', 'Other']);
    expect(deciderLabel({ kind: 'outside_role', role: 'principal_investigator' }, ME, 'record')).toBe('Principal investigator (no platform account)');
    expect(deciderLabel({ kind: 'member', user: { userId: 'u2', name: 'Grace A.', formerMember: true } }, ME, 'record')).toBe('Grace A. (former member)');
    expect(deciderLabel({ kind: 'member', user: { userId: ME, name: 'Amina K.', formerMember: false } }, ME, 'confirmation')).toBe('you');
    expect(deciderLabel({ kind: 'member', user: { userId: 'u2', name: 'Grace A.', formerMember: false } }, ME, 'confirmation')).toBe('Grace A.');
  });

  it('M-11: the summary counts the problems and keeps the answer', () => {
    expect(problemSummary(1)).toBe('There is a problem with this decision. Your text is kept.');
    expect(problemSummary(2)).toBe('There are 2 problems with this decision. Your text is kept.');
    expect(M11.webAddress).toBe('Enter a web address that starts with http:// or https://.');
    expect([M11.monthDays(2, 2028), M11.monthDays(4, 2026), M11.reasonTooLong(12345), M11.unchanged(2)]).toEqual([
      'February has 29 days.', 'April has 30 days.', 'The reason is 12,345 characters. The limit is 4,000.',
      'Nothing has changed since the current decision. Change something before you save.',
    ]);
    expect([M11.scopeAnswer, M11.reasonCode, M11.reasonCodeNotAllowed]).toEqual(['Choose an answer.', 'Choose a main reason.', 'Choose a main reason from the list.']);
    expect(REQUEST_MESSAGES).toEqual({
      body: 'Something went wrong. Reload the page and try again.',
      requestId: 'Something went wrong. Reload the page and try again.',
      stage: 'This page is out of date. Reload it and try again.',
      questionId: 'This question has changed. Reload the page.',
      baseVersionNumber: 'This page is out of date. Reload it and try again.',
      statusOnScope: 'This page is out of date. Reload it and try again.',
      scopeOnPractice: 'This page is out of date. Reload it and try again.',
      optionsNotOfQuestion: 'This page is out of date. Reload it and try again.',
      optionsOnPractice: 'This page is out of date. Reload it and try again.',
      evidenceIds: 'Attach each file or link once.',
      evidenceTooMany: 'Attach at most 100 files or links to one decision.',
      withdrawalCode: 'Choose what kind of mistake it was.',
      noCurrentDecision: 'There is no current decision to withdraw.',
    });
  });

  it('UX-29 UX-42 FR-DEC-08: the withdrawal confirmation names the object and the consequence and repeats the action', () => {
    expect(WITHDRAW_COPY.trigger).toBe('Withdraw this decision');
    expect(WITHDRAW_COPY.action).toBe('Withdraw decision');
    expect(WITHDRAW_COPY.objectName(2, 'Q-PP-01')).toBe('Withdraw the decision on Q-PP-01?');
    expect([WITHDRAW_COPY.codeLabel, WITHDRAW_COPY.chooseOne, WITHDRAW_COPY.reasonLabel, WITHDRAW_COPY.more, WITHDRAW_COPY.retry])
      .toEqual(['What kind of mistake was it?', 'Choose one', 'Explain', 'More actions', 'Retry']);
    expect(WITHDRAW_COPY.consequence).toBe('The question returns to "no decision". Every version stays in the history.');
    expect(Object.values(WITHDRAWAL_CODE_LABELS)).toEqual(['Entered in error', 'Wrong project', 'Duplicate', 'Test entry']);
    expect(WITHDRAWAL_CODES).toEqual(['entered_in_error', 'wrong_project', 'duplicate', 'test_entry']);
  });

  it('the question page title separates the id and the module with a middle dot', () => {
    expect(DECISION_COPY.titles.question('Q-PP-01', 'Problem Formulation')).toBe('Q-PP-01 \u00b7 Problem Formulation');
    expect(DECISION_COPY.titles.history('Q-PP-01')).toBe('History of Q-PP-01');
  });
});

describe('lib/decision/outcome/copy.ts', () => {
  it('the save lines say the outcome as its own sentence and keep "your text" for what was typed', () => {
    expect(DECISION_OUTCOME_COPY.save).toEqual({
      saving: 'Saving...',
      slow: 'Still saving. The connection is slow. A copy of your text is kept in this browser.',
      slowNoStorage: 'Still saving. The connection is slow.',
      connection: 'Not saved. The connection was lost. Your text is still here. Select Retry.',
      noReply: 'Not saved yet. We did not get a reply in time, so your decision may already be saved. Select Retry. It will not save twice.',
      server: 'Not saved. Something went wrong on our side. Your text is still here. Select Retry.',
      signedOut: 'Not saved. You have been signed out. Your text is kept in this browser. Sign in again to save it.',
      signedOutNoStorage: 'Not saved. You have been signed out. Copy your text before you sign in again: this browser cannot keep it.',
      forbidden: 'Not saved. Your role no longer allows this. Ask an Owner or Admin to change your role.',
      archived: 'Not saved. This project is archived. Owners and Admins can unarchive it.',
    });
    expect(DECISION_OUTCOME_COPY.alreadySaved('10:42 EAT', 1)).toBe('This was already saved at 10:42 EAT (version 1).');
    expect(DECISION_OUTCOME_COPY.gate).toEqual({
      terms: 'Not saved. Accept the updated terms first. Copy your text before you go: this browser cannot keep it.',
      password: 'Not saved. Change your password first. Copy your text before you go: this browser cannot keep it.',
      termsLink: 'Go to the terms', passwordLink: 'Change password',
    });
  });

  it('the conflict sentence names who saved the newer version, and "your version" for the reader\'s side', () => {
    expect(DECISION_OUTCOME_COPY.conflict.other('Joseph K.', '10:42 EAT')).toBe('Joseph K. saved a newer version at 10:42 EAT. Compare it with your version, then choose what to keep.');
    expect(DECISION_OUTCOME_COPY.conflict.own('10:42 EAT')).toBe('You saved a newer version at 10:42 EAT. Compare it with your version, then choose what to keep.');
  });

  it('the withdrawal lines', () => {
    expect(DECISION_OUTCOME_COPY.withdraw).toEqual({
      withdrawing: 'Withdrawing...',
      withdrawn: 'Withdrawn. The question has no current decision.',
      maybeArrived: 'Not withdrawn yet. We did not get a reply in time, so it may already be withdrawn. Select Retry. It will not withdraw twice.',
      moved: 'Not withdrawn. Someone saved a newer version. Reload the page to see it.',
      forbidden: 'Not withdrawn. Your role no longer allows this. Ask an Owner or Admin.',
      terms: 'Not withdrawn. Accept the updated terms first.',
      password: 'Not withdrawn. Change your password first.',
      archived: 'Not withdrawn. This project is archived. Owners and Admins can unarchive it.',
      signedOut: 'Not withdrawn. You have been signed out. Sign in again to withdraw it.',
      server: 'Not withdrawn. Something went wrong on our side. Select Retry.',
    });
  });

  it('the kept-evidence line has a singular and a plural', () => {
    expect(DECISION_OUTCOME_COPY.keptEvidence(1)).toBe('1 file or link you added earlier is still part of this decision. It will be attached when you save.');
    expect(DECISION_OUTCOME_COPY.keptEvidence(2)).toBe('2 files or links you added earlier are still part of this decision. They will be attached when you save.');
  });
});

describe('lib/decision/form/copy.ts', () => {
  it('the unsaved line is plan line 925\'s sentence, with no time', () => {
    expect(DECISION_FORM_COPY.unsaved).toBe('Not saved yet. Your text is kept in this browser for up to 7 days. Signing out here, or another person signing in on this browser, removes it.');
    expect(DECISION_FORM_COPY.noStorage).toBe('This browser cannot keep a copy of your text. Save before you leave this page.');
  });

  it('R2: the card\'s heading, the way on, and the consequence sentences as the owner checks them', () => {
    const C = DECISION_FORM_COPY.consequence;
    expect(DECISION_FORM_COPY.card.heading).toBe('Your decision');
    expect(DECISION_FORM_COPY.card.next('Who is affected?')).toBe('Next: Who is affected?');
    expect(DECISION_FORM_COPY.card.position(5, 22)).toBe('Question 5 of 22');
    expect(`${C.keepsOpen('Partly')} ${C.version(2)}`).toBe('Saving \u2018Partly\u2019 keeps a finding open for this question until your team closes it. This save becomes version 2.');
    // The owner's sentence, exact (ruled 15 Nov 2026, 11:45).
    expect(C.raises('Not yet')).toBe('Saving \u2018Not yet\u2019 raises a finding for this question, unless its last finding was closed as an accepted risk at this level or a worse one and no version since was Done or Not applicable.');
    expect(DECISION_FORM_COPY.card.savedAs(2)).toBe('Saved as version 2 \u00b7 ');
    expect(DECISION_FORM_COPY.card.enteredBy('Joseph K.')).toBe('Entered by: Joseph K. on ');
    expect(DECISION_FORM_COPY.conflict.notChosen).toBe('not chosen yet');
    expect(C.raisesNone('Done')).toBe('Saving \u2018Done\u2019 raises no finding.');
    expect(C.closesNot('Not applicable')).toBe("Saving \u2018Not applicable\u2019 does not close the open finding by itself. Your team closes it on the finding's page.");
    expect(C.scope).toEqual({
      yes: 'Saving \u2018Yes\u2019 means the questions about consent and anonymisation apply to this project.',
      no: 'Saving \u2018No\u2019 means the questions about consent and anonymisation do not apply to this project.',
      not_sure: 'Saving \u2018Not sure\u2019 means the questions about consent and anonymisation still apply.',
    });
  });

  it('the field labels (spec 9.3: "Reason", "Decided on") and the personal data question\'s line', () => {
    expect(DECISION_FORM_COPY.fields).toEqual({
      status: 'Status', scopeAnswer: 'Answer', optionsInPlace: 'Which of these are in place?', reasonCode: 'Main reason',
      reason: 'Reason', decidedBy: 'Decided by', declaredDate: 'Decided on',
    });
    expect(DECISION_FORM_COPY.scopeLegend).toBe('Answer (required)');
    expect(DECISION_FORM_COPY.scopeNote).toBe(TERM_PERSONAL_DATA_QUESTION_SCOPE_QUESTION.definition);
    expect(DECISION_FORM_COPY.noAccountGroup).toBe('Someone without a platform account');
    expect(DECISION_FORM_COPY.sameAsMyLast('Oct 2026')).toBe('Same date as my last decision (Oct 2026)');
    expect(DECISION_FORM_COPY.sameAsCurrent('12 Oct 2026')).toBe('Same date as the current decision (12 Oct 2026)');
  });

  it('singular and plural for the kept evidence and the files still uploading', () => {
    expect([DECISION_FORM_COPY.removeKept(1), DECISION_FORM_COPY.removeKept(3)]).toEqual(['Remove it from this decision', 'Remove them from this decision']);
    expect([DECISION_FORM_COPY.saveWithout(1), DECISION_FORM_COPY.saveWithout(2)]).toEqual(['Save without this file', 'Save without these files']);
    // the coordinator's answer to Q17 (b): one file "add it", more than one "add them"
    expect(`${DECISION_FORM_COPY.savedWithout.before}a.pdf${DECISION_FORM_COPY.savedWithout.after}`).toBe('Saved without a.pdf. When the upload has finished, save again to add it.');
    expect(`${DECISION_FORM_COPY.savedWithout.before}a.pdf, b.pdf${DECISION_FORM_COPY.savedWithout.afterMany}`).toBe('Saved without a.pdf, b.pdf. When the upload has finished, save again to add them.');
  });

  it('B3: the line for a link that was not added while Save waited (the wait\'s own line is the evidence block\'s)', () => {
    expect('waitingLink' in DECISION_FORM_COPY).toBe(false);
    // "or clear the box": an address left in the box holds the next Save back too.
    expect(DECISION_FORM_COPY.linkNotAdded).toBe('Not saved. The link was not added. Select Add link again, or clear the box, then save.');
  });

  it('the conflict view: the heading as its own sentence, and "my version" on the buttons', () => {
    expect(DECISION_FORM_COPY.conflict.heading).toBe('Not saved. A newer version was saved while you worked.');
    expect([DECISION_FORM_COPY.conflict.saveMine, DECISION_FORM_COPY.conflict.editMine, DECISION_FORM_COPY.conflict.discardMine])
      .toEqual(['Save my version', 'Edit my version', 'Discard my version']);
    expect([DECISION_FORM_COPY.conflict.saved(2), DECISION_FORM_COPY.conflict.mine]).toEqual(['Saved version (2)', 'Your version (not saved)']);
  });

  // Copy review 17b, finding 14: the ruled texts no other test pins as written, pinned once each.
  it('the form\'s other words, as ruled', () => {
    const F = DECISION_FORM_COPY;
    expect(F.startingNote).toBe('The form shows the current decision. Change what is different, then save.');
    expect(F.optionsCount(2, 5)).toBe('2 of 5 in place');
    expect(F.chooseOne).toBe('Choose one');
    expect(`${F.waiting.before}a.pdf${F.waiting.after}`).toBe('Waiting for a.pdf to finish uploading.');
    expect(F.evidenceFallback).toBe('Evidence');
    expect(F.you('Amina K.')).toBe('You (Amina K.)');
    expect(F.formerMember('Amina K.')).toBe('Amina K. (former member)');
    expect(F.dateHelp).toBe('Leave the day empty if you only know the month. Leave both empty if you only know the year.');
    expect([F.cancel, F.save, F.retry, F.signInAgain]).toEqual(['Cancel', 'Save decision', 'Retry', 'Sign in again']);
    expect([F.conflict.status, F.conflict.reason, F.conflict.decidedBy, F.conflict.evidence, F.conflict.also, F.conflict.none, F.conflict.erased])
      .toEqual(['Status', 'Reason', 'Decided by', 'Evidence', 'Also attached', 'None', 'Text erased']);
    expect(F.conflict.withdrawn('Duplicate')).toBe('Withdrawn: Duplicate');
  });
});

describe('lib/question/copy.ts', () => {
  it('the question page\'s own words', () => {
    expect(QUESTION_COPY.nav.allQuestions).toBe('All questions');
    expect(QUESTION_COPY.nav).not.toHaveProperty('back');
    expect(QUESTION_COPY.reworded).toEqual({ line: 'The description of good practice changed after your team\'s decision.', summary: 'See the earlier description' });
    expect(QUESTION_COPY.headings.seals).toBe('Sealed reviews');
    expect(QUESTION_COPY.current.history(2)).toBe('See all versions (2)');
    expect(QUESTION_COPY.current.withdrawn('Duplicate')).toBe('No decision. The last decision was withdrawn (Duplicate).');
    expect(QUESTION_COPY.current.enteredBy('Joseph K.', '12 Oct 2026', '10:42 EAT')).toBe('Entered by: Joseph K. on 12 Oct 2026 at 10:42 EAT');
    // copy review 17b, finding 14: the rest of the page's words, pinned once each
    expect(QUESTION_COPY.nav.label).toBe('Questions in this stage');
    // Lane 1 Task 1: the position strip names its links in words (frame.previous, frame.next); the old bare words are gone.
    expect(QUESTION_COPY.frame.previous('Who decides?', 3, 'Done')).toBe('Previous question: Who decides? (question 3, Done)');
    expect(QUESTION_COPY.frame.next('Who decides?', 5, 'Partly')).toBe('Next question: Who decides? (question 5, Partly)');
    // Lane 1 Task 3: the reader's way on names the next question's place under "Next: question n".
    expect(QUESTION_COPY.nav.position(10, 24, 'Pre-processing')).toBe('Question 10 of 24 in Pre-processing');
    expect(QUESTION_COPY.headings).not.toHaveProperty('suggestions');
    expect([QUESTION_COPY.headings.current, QUESTION_COPY.headings.record, QUESTION_COPY.headings.findings])
      .toEqual(['Current decision', 'Record a decision', 'Findings']);
    expect(QUESTION_COPY.headings).not.toHaveProperty('question');
    expect(QUESTION_COPY.current.none).toBe('No decision yet.');
    expect(QUESTION_COPY.current.version(2)).toBe('version 2');
    expect(QUESTION_COPY.current.withdrawnNoCode).toBe('No decision. The last decision was withdrawn.');
    expect(QUESTION_COPY.current.decidedBy('Ethics committee', '12 Oct 2026')).toBe('Decided by: Ethics committee, 12 Oct 2026.');
    expect(QUESTION_COPY.current.decidedBy('Ethics committee', null)).toBe('Decided by: Ethics committee.');
    expect(QUESTION_COPY.current.formerMember('Amina K.')).toBe('Amina K. (former member)');
    expect([QUESTION_COPY.current.reason, QUESTION_COPY.current.evidence, QUESTION_COPY.current.noEvidence]).toEqual(['Reason', 'Evidence', 'None']);
  });
});
