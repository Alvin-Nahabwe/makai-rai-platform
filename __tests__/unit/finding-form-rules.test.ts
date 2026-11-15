import { describe, expect, it } from 'vitest';
import type { SendOutcome } from '@/lib/client/retrySafeWrite';
import type { MitigationVersionView } from '@/types/api';
import {
  acceptedLabelSentence, acceptedSavedText, activeUpload, formSummary, raiseRequestBody, acceptRiskFormErrors, characterCount, closedByText, dueDateOf, emptyMitigationValue, mitigationDraftKey, mitigationFormErrors, mitigationRequestBody, mitigationSavedText, saveGate, valueOf,
  type MitigationFormValue,
} from '@/lib/findings/formRules';
import { fieldText, GENERIC_FIELD_TEXT, KEPT_IN_FORM, KEPT_ON_DEVICE, raiseFormErrors, reasonErrors, tooLongText, writeFailure } from '@/lib/findings/formRules';
import { FINDINGS_COPY } from '@/lib/findings/copy';

const rejected = (status: number, code: string, extra: Record<string, unknown> = {}): SendOutcome<unknown> =>
  ({ kind: 'rejected', status, body: { error: 'x', code, ...extra } });
const CLOSED = { state: 'closed_accepted_risk', by: { userId: 'u1', name: 'Grace A.', formerMember: false }, at: '2026-10-30T07:42:00.000Z' };

describe('form failures and field texts (7.4.4, 7.5.7, FND-a RE-2)', () => {
  it('UX-25 FR-FND-03: a cut connection and a silent server read M-05 and M-06, with where the words are', () => {
    expect(writeFailure({ kind: 'not_saved', reason: 'network' }, KEPT_ON_DEVICE)?.text).toBe(FINDINGS_COPY.failures.connectionLost(KEPT_ON_DEVICE));
    expect(writeFailure({ kind: 'not_saved', reason: 'timeout' }, KEPT_IN_FORM)?.text).toBe(FINDINGS_COPY.failures.noReply(KEPT_IN_FORM));
    expect(writeFailure({ kind: 'saved', status: 201, body: {} }, KEPT_ON_DEVICE)).toBeNull();
  });

  it('FR-AUTHZ-01 FR-PRJ-03: 401 reads M-08, 403 reads M-09, an archived project reads M-12, a server problem M-07', () => {
    expect(writeFailure(rejected(401, 'unauthenticated'), KEPT_ON_DEVICE)?.text).toBe(FINDINGS_COPY.failures.signedOut(KEPT_ON_DEVICE));
    expect(writeFailure(rejected(403, 'forbidden'), KEPT_ON_DEVICE)?.text).toBe(FINDINGS_COPY.failures.forbidden(KEPT_ON_DEVICE));
    expect(writeFailure(rejected(409, 'project_archived'), KEPT_ON_DEVICE)?.text).toBe(FINDINGS_COPY.failures.archived);
    expect(writeFailure(rejected(500, 'internal_error'), KEPT_ON_DEVICE)?.text).toBe(FINDINGS_COPY.failures.server(KEPT_ON_DEVICE));
  });

  it('FR-FND-05 7.4.4: a finding closed by someone else reads "This finding was closed by <who> at <time>."', () => {
    expect(closedByText(CLOSED as never, 'Africa/Kampala')).toBe(FINDINGS_COPY.failures.closedBy('Grace A.', '10:42 EAT'));
    expect(writeFailure(rejected(409, 'finding_not_open', { current: CLOSED }), KEPT_IN_FORM, 'UTC')?.text).toBe(FINDINGS_COPY.failures.closedBy('Grace A.', '07:42 UTC'));
  });

  it('FR-FND-06 (R11): a close refused because a mitigation became Planned or In progress reads the close box\'s sentence', () => {
    const f = writeFailure(rejected(409, 'finding_has_open_work'), '', undefined, FINDINGS_COPY.closeByDecision.label);
    expect(f).toMatchObject({ text: FINDINGS_COPY.finding.closeBlocked, retry: false, fields: [] });
  });

  it('FND-a RE-2 NFR-SEC-11: a field text that is not one of ours is replaced by one fixed sentence, a known one is kept', () => {
    expect(fieldText(FINDINGS_COPY.fields.ownerUserId)).toBe(FINDINGS_COPY.fields.ownerUserId);
    expect(fieldText('This is 4,001 characters. The limit is 4,000.')).toBe('This is 4,001 characters. The limit is 4,000.');
    expect(fieldText('relation "findings" violates check constraint <script>')).toBe(GENERIC_FIELD_TEXT);
    const f = writeFailure(rejected(422, 'validation', { fields: [{ field: 'ownerUserId', message: FINDINGS_COPY.fields.ownerUserId }, { field: 'x', message: 'ERROR 23505 duplicate key' }] }), KEPT_ON_DEVICE);
    expect(f?.fields).toEqual([{ field: 'ownerUserId', message: FINDINGS_COPY.fields.ownerUserId }, { field: 'x', message: GENERIC_FIELD_TEXT }]);
  });

  it('FR-FND-03 7.4.4: a base that moved is handed to the form as a conflict with the newer version', () => {
    const f = writeFailure(rejected(409, 'base_version_moved', { current: { versionNumber: 3 } }), KEPT_ON_DEVICE);
    expect(f?.conflict).toEqual({ code: 'base_version_moved', current: { versionNumber: 3 } });
  });
});

describe('the raise form and the reason fields (7.4.2 S-14 row, B14)', () => {
  const OK = { title: 'Labels disagree', description: 'Two annotators differ.', stage: 'in-processing', riskArea: '' };

  it('FR-FND-02: an empty title and no stage are field errors with the 7.4.2 S-14 texts, and a good entry has none', () => {
    expect(raiseFormErrors({ ...OK, title: '   ', stage: '' })).toEqual([
      { field: 'title', message: FINDINGS_COPY.fields.title }, { field: 'stage', message: FINDINGS_COPY.fields.stage }]);
    expect(raiseFormErrors({ ...OK, description: '' })).toEqual([{ field: 'description', message: FINDINGS_COPY.fields.description }]);
    expect(raiseFormErrors(OK)).toEqual([]);
  });

  it('FR-FND-02 (owner default B14): a title of 201 characters and a description of 4,001 are refused with the server\'s own count text; 200 and 4,000 pass', () => {
    expect(raiseFormErrors({ ...OK, title: 'x'.repeat(201) })).toEqual([{ field: 'title', message: tooLongText(201, 200) }]);
    expect(raiseFormErrors({ ...OK, description: 'y'.repeat(4001) })).toEqual([{ field: 'description', message: 'This is 4,001 characters. The limit is 4,000.' }]);
    expect(raiseFormErrors({ ...OK, title: 'x'.repeat(200), description: 'y'.repeat(4000) })).toEqual([]);
    expect(raiseFormErrors({ ...OK, title: '\u{1F600}'.repeat(200) })).toEqual([]);        // an emoji counts once (FR-REV-01's rule)
  });

  it('FR-FND-07: a reopen or withdrawal without a reason is refused with "Write a reason."; the count reads "n / 4,000 characters"', () => {
    expect(reasonErrors(' ')).toEqual([{ field: 'reason', message: FINDINGS_COPY.fields.eventReason }]);
    expect(reasonErrors('The memo was withdrawn.')).toEqual([]);
    expect(characterCount(96)).toBe(FINDINGS_COPY.count(96, 4000));
  });
});

describe('the mitigation form (FR-FND-03, FR-FND-04, UX-16, UX-26, UX-30)', () => {
  const d = (day: string, month: string, year: string) => ({ day, month, year });
  const V: MitigationFormValue = { ...emptyMitigationValue(null), what: 'Relabel the minority class', ownerUserId: 'u-owner', due: d('10', '11', '2026') };
  const MV = { id: 'mv1', mitigationId: 'm1', versionNumber: 2, dueDate: '2026-11-10', status: 'planned', what: 'Relabel', owner: { userId: 'u-owner', name: 'Joseph K.', formerMember: false },
    followsControl: null, closureNote: null, cancelReason: null, evidence: [], receivedAt: '2026-11-02T08:00:00.000Z' } as unknown as MitigationVersionView;

  it('FR-FND-03 UX-16: no owner and no due date are field errors with the 7.4.2 S-15 texts', () => {
    expect(mitigationFormErrors({ ...V, ownerUserId: '', due: d('', '', '') }, null)).toEqual([
      { field: 'ownerUserId', message: FINDINGS_COPY.fields.ownerUserId }, { field: 'dueDate', message: FINDINGS_COPY.fields.dueDate }]);
    expect(mitigationFormErrors({ ...V, due: d('31', '2', '2026') }, null)).toEqual([{ field: 'dueDate', message: FINDINGS_COPY.fields.dueDate }]);
    expect(mitigationFormErrors({ ...V, what: ' ' }, null)).toEqual([{ field: 'what', message: FINDINGS_COPY.fields.what }]);
    expect(mitigationFormErrors(V, null)).toEqual([]);
  });

  it('FR-FND-03: a saved mitigation version reads "Saved as version N of this mitigation at <time>."', () => {
    expect(mitigationSavedText({ ...MV, versionNumber: 3 }, '10:42 EAT')).toBe(FINDINGS_COPY.mitigationForm.savedAs(3, '10:42 EAT'));
  });

  it('FR-FND-04 UX-16: Done with neither evidence nor the no-artefact box is a field error and nothing is sent', () => {
    expect(mitigationFormErrors({ ...V, status: 'done', evidence: [], noArtefact: false }, null)).toEqual([{ field: 'closureNote', message: FINDINGS_COPY.fields.closureNote }]);
    expect(mitigationFormErrors({ ...V, status: 'done', evidence: [], noArtefact: true, closureNote: 'Deployment stopped' }, null)).toEqual([]);
    expect(mitigationFormErrors({ ...V, status: 'done', evidence: [], noArtefact: true, closureNote: ' ' }, null)).toEqual([{ field: 'closureNote', message: FINDINGS_COPY.fields.closureNote }]);
    expect(mitigationFormErrors({ ...V, status: 'done', evidence: [{ id: 'e1' } as never], noArtefact: false }, null)).toEqual([]);
  });

  it('FR-FND-03: cancelling needs a reason', () => {
    expect(mitigationFormErrors({ ...V, status: 'cancelled' }, null)).toEqual([{ field: 'cancelReason', message: FINDINGS_COPY.fields.cancelReason }]);
    expect(mitigationFormErrors({ ...V, status: 'cancelled', cancelReason: 'No longer needed' }, null)).toEqual([]);
  });

  it('FR-FND-03: moving the due date later asks for a change note; earlier does not', () => {
    expect(mitigationFormErrors({ ...V, due: d('20', '11', '2026') }, MV)).toEqual([{ field: 'changeNote', message: FINDINGS_COPY.fields.changeNote }]);
    expect(mitigationFormErrors({ ...V, due: d('20', '11', '2026'), changeNote: 'Waiting for the labeller.' }, MV)).toEqual([]);
    expect(mitigationFormErrors({ ...V, due: d('5', '11', '2026') }, MV)).toEqual([]);
  });

  it('FR-FND-03: the due date is a real calendar date, read from day, month and year', () => {
    expect(dueDateOf(d('5', '11', '2026'))).toBe('2026-11-05');
    expect(dueDateOf(d('29', '2', '2028'))).toBe('2028-02-29');
    for (const bad of [d('29', '2', '2027'), d('', '11', '2026'), d('5', '13', '2026'), d('5', '11', '26'), d('x', '1', '2026')]) expect(dueDateOf(bad), JSON.stringify(bad)).toBeNull();
  });

  it('UX-30 (form half): a file still uploading holds the save with the waiting line', () => {
    expect(saveGate({ uploading: ['plan.pdf'], failed: [] })).toEqual({ send: false, text: FINDINGS_COPY.mitigationForm.waiting(['plan.pdf']), actions: [FINDINGS_COPY.mitigationForm.saveWithout, FINDINGS_COPY.mitigationForm.cancel] });
    expect(saveGate({ uploading: ['a.pdf'], failed: ['b.pdf'] }).text).toBe(FINDINGS_COPY.mitigationForm.waiting(['a.pdf', 'b.pdf']));
    expect(saveGate({ uploading: [], failed: [] })).toEqual({ send: true, text: null, actions: [] });
  });

  it('UX-26 NFR-PRIV-06: the mitigation form keeps its draft under the account\'s mitigation key only', () => {
    expect(mitigationDraftKey({ userId: 'u1', orgId: 'o1', projectId: 'p1', findingId: 'f1', mitigationId: null })).toBe('makrai.draft.v1:u1:o1:p1:m:f1:new');
    expect(mitigationDraftKey({ userId: 'u1', orgId: 'o1', projectId: 'p1', findingId: 'f1', mitigationId: 'm9' })).toBe('makrai.draft.v1:u1:o1:p1:m:f1:m9');
  });

  it('FR-FND-03 FR-FND-04: the request carries the evidence ids, the note only for Done, the reason only for Cancelled, and the base and change note for an update', () => {
    const add = mitigationRequestBody({ ...V, status: 'done', evidence: [{ id: 'e1' } as never], noArtefact: true, closureNote: 'Stopped' }, null);
    expect(add).toEqual({ what: 'Relabel the minority class', ownerUserId: 'u-owner', dueDate: '2026-11-10', status: 'done', followsControl: null,
      closureNote: 'Stopped', cancelReason: null, evidenceIds: ['e1'] });
    const upd = mitigationRequestBody({ ...V, status: 'in_progress', closureNote: 'left over', noArtefact: true, due: d('20', '11', '2026'), changeNote: ' later ' }, MV);
    expect(upd).toMatchObject({ status: 'in_progress', closureNote: null, cancelReason: null, baseVersionNumber: 2, changeNote: 'later' });
    expect(mitigationRequestBody({ ...V, changeNote: 'unneeded' }, MV)).toMatchObject({ changeNote: null });   // the date did not move later
    expect(valueOf(MV)).toMatchObject({ what: 'Relabel', ownerUserId: 'u-owner', due: d('10', '11', '2026'), status: 'planned' });
  });
});

describe('the accepted-risk form (FR-FND-05, UX-17, W-6)', () => {
  const NAMES = new Map([['u-grace', 'Grace A.']]);

  it('FR-FND-05 UX-17: the accept form refuses an empty reason and no choice with the S-15 texts, and the saved line names who', () => {
    expect(acceptRiskFormErrors({ acceptedBy: null, reason: '  ' })).toEqual([
      { field: 'acceptedBy', message: FINDINGS_COPY.fields.acceptedBy }, { field: 'reason', message: FINDINGS_COPY.fields.acceptReason }]);
    expect(acceptRiskFormErrors({ acceptedBy: { kind: 'member', userId: 'u-grace' }, reason: 'Minutes of 30 Oct.' })).toEqual([]);
    // A3: the saved line quotes the label the page shows, the role alone.
    expect(acceptedSavedText({ kind: 'outside_role', role: 'ethics_committee' }, NAMES)).toBe('Closed by an accepted risk (Ethics committee).');
  });

  it('FR-FND-05: a look-again date that is not a real date, and a keep-accepted without its note, are field errors', () => {
    const ok = { acceptedBy: { kind: 'member', userId: 'u-grace' } as const, reason: 'Still fine.' };
    expect(acceptRiskFormErrors({ ...ok, lookAgain: { day: '31', month: '2', year: '2027' } })).toEqual([{ field: 'lookAgainOn', message: FINDINGS_COPY.fields.lookAgainOn }]);
    expect(acceptRiskFormErrors({ ...ok, lookAgain: { day: '', month: '', year: '' } })).toEqual([]);
    expect(acceptRiskFormErrors({ ...ok, note: '  ', requireNote: true })).toEqual([{ field: 'lookAgainNote', message: FINDINGS_COPY.fields.lookAgainNote }]);
  });

  it('UX-17: the sentence names the choice and updates when it changes', () => {
    expect(acceptedLabelSentence({ kind: 'outside_role', role: 'ethics_committee' }, NAMES)).toBe('The finding will show as "Closed by an accepted risk (Ethics committee)".');
    expect(acceptedLabelSentence({ kind: 'member', userId: 'u-grace' }, NAMES)).toBe(FINDINGS_COPY.acceptRisk.willShow('Grace A.'));
    expect(acceptedLabelSentence(null, NAMES)).toBe('');
  });
});

describe('the copies of the server texts (SI-4)', () => {
  it('FND-a RE-2: every user-facing text of the server\'s finding messages is one the form shows as it is, and the limits match', async () => {
    const { FINDING_MESSAGES, TEXT_MAX: SERVER_TEXT_MAX, CHANGE_NOTE_MAX: SERVER_NOTE_MAX } = await import('@/lib/findings/validate');
    const { TEAM_FINDING_MESSAGES } = await import('@/lib/data/teamFindings');
    const { FIELD_TEXTS, TEXT_MAX, CHANGE_NOTE_MAX } = await import('@/lib/findings/formRules');
    // Texts that name a field the person cannot see or fix are meant to become the fixed sentence.
    const developer = new Set(['body', 'requestId', 'baseVersionNumber', 'mode', 'eventCode', 'lookAgainOn_', 'evidenceIds_']);
    const users = Object.entries(FINDING_MESSAGES).filter(([k, v]) => typeof v === 'string' && !developer.has(k));
    const missing = users.map(([, v]) => v as string).filter((v) => !FIELD_TEXTS.has(v));
    expect(missing, 'server texts the form would replace by the fixed sentence').toEqual([]);
    for (const v of Object.values(TEAM_FINDING_MESSAGES)) expect(FIELD_TEXTS.has(v), v).toBe(true);
    expect(TEXT_MAX).toBe(SERVER_TEXT_MAX);
    expect(CHANGE_NOTE_MAX).toBe(SERVER_NOTE_MAX);
  });
});

describe('C4 hunter minors (SFH-7, SFH-8, SFH-9)', () => {
  it('SFH-8 UX-26: the error summary says where the words are, so it is not "kept on this device" when no draft can be kept', () => {
    expect(formSummary('mitigation', 1, KEPT_ON_DEVICE)).toBe(FINDINGS_COPY.summary('mitigation', 1, KEPT_ON_DEVICE));
    expect(formSummary('mitigation', 3, KEPT_IN_FORM)).toBe(FINDINGS_COPY.summary('mitigation', 3, KEPT_IN_FORM));
  });

  it('SFH-9 UX-27: the raise request carries trimmed NFC text, so whitespace alone does not make a new request id', () => {
    const v = { title: '  Cafe\u0301  ', description: '\nOk\n', stage: 'in-processing', riskArea: '' };
    expect(raiseRequestBody(v, null)).toEqual({ stage: 'in-processing', title: 'Caf\u00e9', description: 'Ok', riskArea: null, questionId: null, decisionVersionId: null });
    expect(raiseRequestBody({ ...v, title: 'Caf\u00e9' }, null)).toEqual(raiseRequestBody(v, null));
    expect(raiseRequestBody({ ...v, riskArea: 'PP-07' }, { stage: 'in-processing', questionId: 'Q-1', versionId: 'v1' })).toMatchObject({ riskArea: 'PP-07', questionId: 'Q-1', decisionVersionId: 'v1' });
    expect(raiseRequestBody(v, { stage: 'pre-processing', questionId: 'Q-1', versionId: 'v1' })).toMatchObject({ questionId: null, decisionVersionId: null });
  });

  it('SFH-7 UX-30: an upload only holds the save while the status is Done (the block is gone otherwise)', () => {
    const up = { uploading: ['a.pdf'], failed: ['b.pdf'] };
    expect(activeUpload('done', up)).toEqual(up);
    for (const s of ['planned', 'in_progress', 'cancelled'] as const) expect(activeUpload(s, up)).toEqual({ uploading: [], failed: [] });
  });
});

describe('one copy of the field messages (plan 1A Task 18, part 18a)', () => {
  it('FND-a RE-2: every field message the server can send a form passes fieldText unchanged, and each is the copy module\'s own string', async () => {
    const { FINDING_MESSAGES } = await import('@/lib/findings/validate');
    const { TEAM_FINDING_MESSAGES } = await import('@/lib/data/teamFindings');
    const { FIELD_TEXTS } = await import('@/lib/findings/formRules');
    const copy = new Set<string>(Object.values(FINDINGS_COPY.fields));
    // The developer texts name a field the person cannot see or fix: the form shows the fixed sentence for them.
    const developer = new Set(['body', 'requestId', 'baseVersionNumber', 'mode', 'eventCode']);
    const served = [
      ...Object.entries(FINDING_MESSAGES).filter(([k, v]) => typeof v === 'string' && !developer.has(k)).map(([, v]) => v as string),
      ...Object.values(TEAM_FINDING_MESSAGES),
    ];
    expect(served.length).toBeGreaterThan(20);
    for (const m of served) {
      expect(fieldText(m), m).toBe(m);
      expect(copy.has(m), `${m} is not FINDINGS_COPY.fields' own text`).toBe(true);
    }
    expect([...FIELD_TEXTS].sort()).toEqual([...copy].sort());
    expect(fieldText(FINDING_MESSAGES.tooLong(4001, 4000))).toBe(FINDINGS_COPY.tooLong(4001, 4000));
  });

  it('a failure with no kept-text sentence (the close button) leaves no double space', () => {
    for (const outcome of [{ kind: 'not_saved', reason: 'timeout' }, { kind: 'not_saved', reason: 'network' }] as const) {
      const text = writeFailure(outcome, '')?.text ?? '';
      expect(text).not.toMatch(/ {2}/);
      expect(text).not.toContain(KEPT_IN_FORM);
    }
    expect(writeFailure(rejected(503, 'unavailable'), '')?.text).toBe(FINDINGS_COPY.failures.server(''));
  });

  it('the ruled sentences (coordinator Q1 with the lead\'s H1; S-D; S-Q2 with S-R)', () => {
    expect(FINDINGS_COPY.failures.noReply(KEPT_ON_DEVICE)).toBe(
      'Not saved yet. We did not get a reply in time, so it may already be saved. Your text is kept in this browser. Select Retry. It will not save twice.');
    expect(FINDINGS_COPY.failures.connectionLost('')).toBe('Not saved. Connection lost. Select Retry.');
    expect(KEPT_ON_DEVICE).toBe('Your text is kept in this browser.');
  });

  it('A4 (ruling L5-5): an action with no Retry button names its own button in the retryable lines', () => {
    const again = 'Withdraw finding';
    expect(writeFailure({ kind: 'not_saved', reason: 'timeout' }, KEPT_IN_FORM, undefined, again)?.text).toBe(
      'Not saved yet. We did not get a reply in time, so it may already be saved. What you typed is still in the form. Select Withdraw finding again. It will not save twice.');
    expect(writeFailure({ kind: 'not_saved', reason: 'network' }, KEPT_IN_FORM, undefined, again)?.text).toBe(
      'Not saved. Connection lost. What you typed is still in the form. Select Withdraw finding again.');
    expect(writeFailure(rejected(429, 'rate_limited'), KEPT_IN_FORM, undefined, again)?.text).toBe(
      'Not saved. Too many requests. What you typed is still in the form. Wait a minute, then select Withdraw finding again.');
    expect(writeFailure(rejected(500, 'internal_error'), '', undefined, again)?.text).toBe(
      'Not saved. The server had a problem. Select Withdraw finding again.');
    // The mitigation form has a Retry button and keeps "Select Retry.".
    expect(writeFailure(rejected(500, 'internal_error'), '')?.text).toBe('Not saved. The server had a problem. Select Retry.');
  });
});
