import { describe, it, expect } from 'vitest';
import { conflictText, savingStatus, statusForOutcome } from '@/lib/question/saveOutcome';
import type { SendOutcome } from '@/lib/client/retrySafeWrite';
import type { DecisionVersionView } from '@/types/api';
import type { FieldError } from '@/types/record';

/**
 * The status line of a decision save (7.4.1, 7.4.3; M-01 to M-12, SRS lines 2548-2559): each outcome of
 * `sendWrite` maps to exactly one message, polite for progress and success, assertive for every failure (UX-25).
 */
const T = (_iso: string) => '10:42 EAT';
const ME = 'u-me';
const V1 = {
  id: 'dv1', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', versionNumber: 1, baseVersionNumber: null,
  content: { contentVersionId: 'c1', semver: '0.0.1-fixture', contentHash: 'h' }, status: 'done', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: 'Mine', reasonErased: null,
  decidedBy: { kind: 'member', user: { userId: ME, name: 'Amina N.', formerMember: false } },
  declaredDate: '2026-10-12', declaredPrecision: 'day', withdrawalCode: null,
  enteredBy: { userId: ME, name: 'Amina N.', formerMember: false }, enteredByRole: 'assessor',
  receivedAt: '2026-10-12T07:42:00.000Z', evidence: [],
} satisfies DecisionVersionView;
const V2: DecisionVersionView = { ...V1, id: 'dv2', versionNumber: 2, baseVersionNumber: 1 };
const rej = (status: number, code: string, fields?: FieldError[]): SendOutcome<DecisionVersionView> =>
  ({ kind: 'rejected', status, body: { error: '', code, fields } });

describe('decision save outcome', () => {
  it('UX-25 M-01 M-02: saving, then still saving after 10 seconds, both polite', () => {
    expect(savingStatus(false)).toEqual({ id: 'M-01', text: 'Saving...', live: 'polite', next: 'none' });
    expect(savingStatus(true)).toEqual({ id: 'M-02', text: 'Still saving. The connection is slow. Your answer is kept on this device.', live: 'polite', next: 'none' });
  });

  it('FR-DEC-06 M-03 M-04: a new version and a replayed one', () => {
    expect(statusForOutcome({ kind: 'saved', status: 201, body: V1 }, { viewerId: ME, timeText: T }))
      .toEqual({ id: 'M-03', text: 'Saved as version 1 at 10:42 EAT. Decided by: you. Entered by: you.', live: 'polite', next: 'none' });
    expect(statusForOutcome({ kind: 'saved', status: 200, body: V1 }, { viewerId: ME, timeText: T }))
      .toMatchObject({ id: 'M-04', text: 'Already saved as version 1 at 10:42 EAT.', live: 'polite' });
  });

  it.each([
    [{ kind: 'not_saved', reason: 'network' }, 'M-05', 'Not saved: connection lost. Your answer is kept on this device. Retry.', 'retry'],
    [{ kind: 'not_saved', reason: 'timeout' }, 'M-06', 'Not saved: no reply from the server after 30 seconds. It may have arrived. Your answer is kept on this device. Retry is safe: it will not save twice.', 'retry'],
    [rej(500, 'x'), 'M-07', 'Not saved: the server had a problem. Your answer is kept on this device. Retry.', 'retry'],
    [rej(401, 'unauthenticated'), 'M-08', 'Not saved: you have been signed out. Your answer is kept on this device. Sign in again to save it.', 'sign_in'],
    [rej(403, 'forbidden'), 'M-09', 'Not saved: your role in this organisation no longer allows this. Your answer is kept on this device. Ask an owner or admin.', 'none'],
    [rej(409, 'project_archived'), 'M-12', 'Not saved: this project is archived. Owners and admins can unarchive it.', 'none'],
    [rej(409, 'request_id_reused'), 'M-07', 'Not saved: the server had a problem. Your answer is kept on this device. Retry.', 'retry'],
    [rej(429, 'rate_limited'), 'M-07', 'Not saved: the server had a problem. Your answer is kept on this device. Retry.', 'retry'],
  ])('UX-25 FR-DEC-06: %j shows %s, assertively', (o, id, text, next) => {
    expect(statusForOutcome(o as SendOutcome<DecisionVersionView>, { viewerId: ME, timeText: T })).toEqual({ id, text, live: 'assertive', next });
  });

  it('M-10 UX-28: a 409 base_version_moved is the conflict, assertively', () => {
    const o = { kind: 'rejected', status: 409, body: { error: '', code: 'base_version_moved', current: { ...V2, enteredBy: { userId: 'u-j', name: 'Joseph K.', formerMember: false } } } } as const;
    expect(statusForOutcome(o, { viewerId: ME, timeText: T })).toEqual({
      id: 'M-10', live: 'assertive', next: 'conflict',
      text: 'Version 2 was saved by Joseph K. at 10:42 EAT after you started. Review it, then save yours as version 3 or discard it.',
    });
  });

  it('M-10 UX-28: the conflict names who saved and when, and says so when it was the same account', () => {
    expect(conflictText({ ...V2, enteredBy: { userId: 'u-j', name: 'Joseph K.', formerMember: false } }, ME, T))
      .toBe('Version 2 was saved by Joseph K. at 10:42 EAT after you started. Review it, then save yours as version 3 or discard it.');
    expect(conflictText({ ...V2, enteredBy: { userId: ME, name: 'Amina N.', formerMember: false } }, ME, T))
      .toBe('Version 2 was saved by you at 10:42 EAT, probably by an earlier attempt from this device or another device. Review it, then save yours as version 3 or discard it.');
  });

  it('M-11: a 422 shows the summary and keeps the answer', () => {
    expect(statusForOutcome(rej(422, 'validation', [{ field: 'reason', message: 'x' }, { field: 'decidedBy', message: 'y' }]), { viewerId: ME, timeText: T }))
      .toEqual({ id: 'M-11', text: 'There are 2 problems with this decision. Your answer is kept.', live: 'assertive', next: 'fix' });
    expect(statusForOutcome(rej(422, 'validation'), { viewerId: ME, timeText: T }))
      .toMatchObject({ id: 'M-11', text: 'There is a problem with this decision. Your answer is kept.' });
  });

  it('NFR-REL-04 FR-DEC-06: a 409 base_version_moved without its current version is not a conflict view but a server problem', () => {
    expect(statusForOutcome(rej(409, 'base_version_moved'), { viewerId: ME, timeText: T })).toMatchObject({ id: 'M-07', next: 'retry' });
  });

  it('NFR-REL-04: a 2xx whose body is not a decision version (a 204, an empty object) never says Saved', () => {
    expect(statusForOutcome({ kind: 'saved', status: 204, body: undefined as unknown as DecisionVersionView }, { viewerId: ME, timeText: T })).toMatchObject({ id: 'M-07', next: 'retry' });
    expect(statusForOutcome({ kind: 'saved', status: 201, body: {} as DecisionVersionView }, { viewerId: ME, timeText: T })).toMatchObject({ id: 'M-07', next: 'retry' });
  });

  it('M-11: a 422 with no field list names the server\'s own line, not an empty summary', () => {
    expect(statusForOutcome({ kind: 'rejected', status: 422, body: { error: 'This is the same as version 1.', code: 'validation' } }, { viewerId: ME, timeText: T }))
      .toMatchObject({ id: 'M-11', next: 'fix' });
  });
});
