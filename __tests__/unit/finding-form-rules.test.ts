import { describe, expect, it } from 'vitest';
import type { SendOutcome } from '@/lib/client/retrySafeWrite';
import type { MitigationVersionView } from '@/types/api';
import {
  characterCount, closedByText, dueDateOf, emptyMitigationValue, mitigationDraftKey, mitigationFormErrors, mitigationRequestBody, mitigationSavedText, saveGate, valueOf,
  type MitigationFormValue,
} from '@/lib/findings/formRules';
import { fieldText, GENERIC_FIELD_TEXT, KEPT_IN_FORM, KEPT_ON_DEVICE, raiseFormErrors, reasonErrors, tooLongText, writeFailure } from '@/lib/findings/formRules';

const rejected = (status: number, code: string, extra: Record<string, unknown> = {}): SendOutcome<unknown> =>
  ({ kind: 'rejected', status, body: { error: 'x', code, ...extra } });
const CLOSED = { state: 'closed_accepted_risk', by: { userId: 'u1', name: 'Grace A.', formerMember: false }, at: '2026-10-30T07:42:00.000Z' };

describe('form failures and field texts (7.4.4, 7.5.7, FND-a RE-2)', () => {
  it('UX-25 FR-FND-03: a cut connection and a silent server read M-05 and M-06, with where the words are', () => {
    expect(writeFailure({ kind: 'not_saved', reason: 'network' }, KEPT_ON_DEVICE)?.text).toBe('Not saved: connection lost. Your answer is kept on this device. Retry.');
    expect(writeFailure({ kind: 'not_saved', reason: 'timeout' }, KEPT_IN_FORM)?.text).toBe(
      'Not saved: no reply from the server after 30 seconds. It may have arrived. What you typed is still in the form. Retry is safe: it will not save twice.');
    expect(writeFailure({ kind: 'saved', status: 201, body: {} }, KEPT_ON_DEVICE)).toBeNull();
  });

  it('FR-AUTHZ-01 FR-PRJ-03: 401 reads M-08, 403 reads M-09, an archived project reads M-12, a server problem M-07', () => {
    expect(writeFailure(rejected(401, 'unauthenticated'), KEPT_ON_DEVICE)?.text).toBe('Not saved: you have been signed out. Your answer is kept on this device. Sign in again to save it.');
    expect(writeFailure(rejected(403, 'forbidden'), KEPT_ON_DEVICE)?.text).toBe('Not saved: your role in this organisation no longer allows this. Your answer is kept on this device. Ask an owner or admin.');
    expect(writeFailure(rejected(409, 'project_archived'), KEPT_ON_DEVICE)?.text).toBe('Not saved: this project is archived. Owners and admins can unarchive it.');
    expect(writeFailure(rejected(500, 'internal_error'), KEPT_ON_DEVICE)?.text).toBe('Not saved: the server had a problem. Your answer is kept on this device. Retry.');
  });

  it('FR-FND-05 7.4.4: a finding closed by someone else reads "This finding was closed by <who> at <time>."', () => {
    expect(closedByText(CLOSED as never, 'Africa/Kampala')).toBe('This finding was closed by Grace A. at 10:42 EAT.');
    expect(writeFailure(rejected(409, 'finding_not_open', { current: CLOSED }), KEPT_IN_FORM, 'UTC')?.text).toBe('This finding was closed by Grace A. at 07:42 UTC.');
  });

  it('FND-a RE-2 NFR-SEC-11: a field text that is not one of ours is replaced by one fixed sentence, a known one is kept', () => {
    expect(fieldText('Choose an owner.')).toBe('Choose an owner.');
    expect(fieldText('This is 4,001 characters. The limit is 4,000.')).toBe('This is 4,001 characters. The limit is 4,000.');
    expect(fieldText('relation "findings" violates check constraint <script>')).toBe(GENERIC_FIELD_TEXT);
    const f = writeFailure(rejected(422, 'validation', { fields: [{ field: 'ownerUserId', message: 'Choose an owner.' }, { field: 'x', message: 'ERROR 23505 duplicate key' }] }), KEPT_ON_DEVICE);
    expect(f?.fields).toEqual([{ field: 'ownerUserId', message: 'Choose an owner.' }, { field: 'x', message: GENERIC_FIELD_TEXT }]);
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
      { field: 'title', message: 'Write a title.' }, { field: 'stage', message: 'Choose a stage.' }]);
    expect(raiseFormErrors({ ...OK, description: '' })).toEqual([{ field: 'description', message: 'Write a description.' }]);
    expect(raiseFormErrors(OK)).toEqual([]);
  });

  it('FR-FND-02 (owner default B14): a title of 201 characters and a description of 4,001 are refused with the server\'s own count text; 200 and 4,000 pass', () => {
    expect(raiseFormErrors({ ...OK, title: 'x'.repeat(201) })).toEqual([{ field: 'title', message: tooLongText(201, 200) }]);
    expect(raiseFormErrors({ ...OK, description: 'y'.repeat(4001) })).toEqual([{ field: 'description', message: 'This is 4,001 characters. The limit is 4,000.' }]);
    expect(raiseFormErrors({ ...OK, title: 'x'.repeat(200), description: 'y'.repeat(4000) })).toEqual([]);
    expect(raiseFormErrors({ ...OK, title: '\u{1F600}'.repeat(200) })).toEqual([]);        // an emoji counts once (FR-REV-01's rule)
  });

  it('FR-FND-07: a reopen or withdrawal without a reason is refused with "Write a reason."; the count reads "n / 4,000 characters"', () => {
    expect(reasonErrors(' ')).toEqual([{ field: 'reason', message: 'Write a reason.' }]);
    expect(reasonErrors('The memo was withdrawn.')).toEqual([]);
    expect(characterCount(96)).toBe('96 / 4,000 characters');
  });
});

describe('the mitigation form (FR-FND-03, FR-FND-04, UX-16, UX-26, UX-30)', () => {
  const d = (day: string, month: string, year: string) => ({ day, month, year });
  const V: MitigationFormValue = { ...emptyMitigationValue(null), what: 'Relabel the minority class', ownerUserId: 'u-owner', due: d('10', '11', '2026') };
  const MV = { id: 'mv1', mitigationId: 'm1', versionNumber: 2, dueDate: '2026-11-10', status: 'planned', what: 'Relabel', owner: { userId: 'u-owner', name: 'Joseph K.', formerMember: false },
    followsControl: null, closureNote: null, cancelReason: null, evidence: [], receivedAt: '2026-11-02T08:00:00.000Z' } as unknown as MitigationVersionView;

  it('FR-FND-03 UX-16: no owner and no due date are field errors with the 7.4.2 S-15 texts', () => {
    expect(mitigationFormErrors({ ...V, ownerUserId: '', due: d('', '', '') }, null)).toEqual([
      { field: 'ownerUserId', message: 'Choose an owner.' }, { field: 'dueDate', message: 'Enter a due date.' }]);
    expect(mitigationFormErrors({ ...V, due: d('31', '2', '2026') }, null)).toEqual([{ field: 'dueDate', message: 'Enter a due date.' }]);
    expect(mitigationFormErrors({ ...V, what: ' ' }, null)).toEqual([{ field: 'what', message: 'Write what will be done.' }]);
    expect(mitigationFormErrors(V, null)).toEqual([]);
  });

  it('FR-FND-03: a saved mitigation version reads "Saved as version N of this mitigation at <time>."', () => {
    expect(mitigationSavedText({ ...MV, versionNumber: 3 }, '10:42 EAT')).toBe('Saved as version 3 of this mitigation at 10:42 EAT.');
  });

  it('FR-FND-04 UX-16: Done with neither evidence nor the no-artefact box is a field error and nothing is sent', () => {
    expect(mitigationFormErrors({ ...V, status: 'done', evidence: [], noArtefact: false }, null)).toEqual([{ field: 'closureNote', message: 'Add closure evidence, or say why there is none.' }]);
    expect(mitigationFormErrors({ ...V, status: 'done', evidence: [], noArtefact: true, closureNote: 'Deployment stopped' }, null)).toEqual([]);
    expect(mitigationFormErrors({ ...V, status: 'done', evidence: [], noArtefact: true, closureNote: ' ' }, null)).toEqual([{ field: 'closureNote', message: 'Add closure evidence, or say why there is none.' }]);
    expect(mitigationFormErrors({ ...V, status: 'done', evidence: [{ id: 'e1' } as never], noArtefact: false }, null)).toEqual([]);
  });

  it('FR-FND-03: cancelling needs a reason', () => {
    expect(mitigationFormErrors({ ...V, status: 'cancelled' }, null)).toEqual([{ field: 'cancelReason', message: 'Say why it is cancelled.' }]);
    expect(mitigationFormErrors({ ...V, status: 'cancelled', cancelReason: 'No longer needed' }, null)).toEqual([]);
  });

  it('FR-FND-03: moving the due date later asks for a change note; earlier does not', () => {
    expect(mitigationFormErrors({ ...V, due: d('20', '11', '2026') }, MV)).toEqual([{ field: 'changeNote', message: 'Say why the date changed.' }]);
    expect(mitigationFormErrors({ ...V, due: d('20', '11', '2026'), changeNote: 'Waiting for the labeller.' }, MV)).toEqual([]);
    expect(mitigationFormErrors({ ...V, due: d('5', '11', '2026') }, MV)).toEqual([]);
  });

  it('FR-FND-03: the due date is a real calendar date, read from day, month and year', () => {
    expect(dueDateOf(d('5', '11', '2026'))).toBe('2026-11-05');
    expect(dueDateOf(d('29', '2', '2028'))).toBe('2028-02-29');
    for (const bad of [d('29', '2', '2027'), d('', '11', '2026'), d('5', '13', '2026'), d('5', '11', '26'), d('x', '1', '2026')]) expect(dueDateOf(bad), JSON.stringify(bad)).toBeNull();
  });

  it('UX-30 (form half): a file still uploading holds the save with the waiting line', () => {
    expect(saveGate({ uploading: ['plan.pdf'], failed: [] })).toEqual({ send: false, text: 'Waiting for plan.pdf to finish uploading.', actions: ['Save without it', 'Cancel'] });
    expect(saveGate({ uploading: ['a.pdf'], failed: ['b.pdf'] }).text).toBe('Waiting for a.pdf, b.pdf to finish uploading.');
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
