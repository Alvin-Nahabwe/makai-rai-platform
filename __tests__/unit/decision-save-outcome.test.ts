import { describe, it, expect } from 'vitest';
import { openDraftStore, type DraftKey, type StoredDraft } from '@/lib/client/drafts';
import { draftHeldForGate } from '@/lib/question/draft';
import { conflictText, gateStatus, navigationForOutcome, savingStatus, statusForOutcome, withdrawOutcome, WITHDRAW_TEXT } from '@/lib/question/saveOutcome';
import type { SendOutcome } from '@/lib/client/retrySafeWrite';
import type { DecisionVersionView } from '@/types/api';
import type { FieldError } from '@/types/record';
import { DECISION_OUTCOME_COPY } from '@/lib/decision/outcome/copy';
import { problemSummary, savedLine } from '@/lib/decision/copy';

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
    expect(savingStatus(false)).toEqual({ id: 'M-01', text: DECISION_OUTCOME_COPY.save.saving, live: 'polite', next: 'none' });
    expect(savingStatus(true)).toEqual({ id: 'M-02', text: DECISION_OUTCOME_COPY.save.slow, live: 'polite', next: 'none' });
  });

  it('FR-DEC-06 M-03 M-04: a new version and a replayed one', () => {
    expect(statusForOutcome({ kind: 'saved', status: 201, body: V1 }, { viewerId: ME, timeText: T }))
      .toEqual({ id: 'M-03', text: savedLine('10:42 EAT', 1, 'you'), live: 'polite', next: 'none' });
    expect(statusForOutcome({ kind: 'saved', status: 200, body: V1 }, { viewerId: ME, timeText: T }))
      .toMatchObject({ id: 'M-04', text: DECISION_OUTCOME_COPY.alreadySaved('10:42 EAT', 1), live: 'polite' });
  });

  it.each([
    [{ kind: 'not_saved', reason: 'network' }, 'M-05', DECISION_OUTCOME_COPY.save.connection, 'retry'],
    [{ kind: 'not_saved', reason: 'timeout' }, 'M-06', DECISION_OUTCOME_COPY.save.noReply, 'retry'],
    [rej(500, 'x'), 'M-07', DECISION_OUTCOME_COPY.save.server, 'retry'],
    [rej(401, 'unauthenticated'), 'M-08', DECISION_OUTCOME_COPY.save.signedOut, 'sign_in'],
    [rej(403, 'forbidden'), 'M-09', DECISION_OUTCOME_COPY.save.forbidden, 'none'],
    [rej(409, 'project_archived'), 'M-12', DECISION_OUTCOME_COPY.save.archived, 'none'],
    [rej(409, 'request_id_reused'), 'M-07', DECISION_OUTCOME_COPY.save.server, 'retry'],
    [rej(429, 'rate_limited'), 'M-07', DECISION_OUTCOME_COPY.save.server, 'retry'],
  ])('UX-25 FR-DEC-06: %j shows %s, assertively', (o, id, text, next) => {
    expect(statusForOutcome(o as SendOutcome<DecisionVersionView>, { viewerId: ME, timeText: T })).toEqual({ id, text, live: 'assertive', next });
  });

  it('M-10 UX-28: a 409 base_version_moved is the conflict, assertively', () => {
    const o = { kind: 'rejected', status: 409, body: { error: '', code: 'base_version_moved', current: { ...V2, enteredBy: { userId: 'u-j', name: 'Joseph K.', formerMember: false } } } } as const;
    expect(statusForOutcome(o, { viewerId: ME, timeText: T })).toEqual({
      id: 'M-10', live: 'assertive', next: 'conflict',
      text: DECISION_OUTCOME_COPY.conflict.other('Joseph K.', '10:42 EAT'),
    });
  });

  it('M-10 UX-28: the conflict names who saved and when, and says so when it was the same account', () => {
    expect(conflictText({ ...V2, enteredBy: { userId: 'u-j', name: 'Joseph K.', formerMember: false } }, ME, T))
      .toBe(DECISION_OUTCOME_COPY.conflict.other('Joseph K.', '10:42 EAT'));
    expect(conflictText({ ...V2, enteredBy: { userId: ME, name: 'Amina N.', formerMember: false } }, ME, T))
      .toBe(DECISION_OUTCOME_COPY.conflict.own('10:42 EAT'));
  });

  it('M-11: a 422 shows the summary and keeps the answer', () => {
    expect(statusForOutcome(rej(422, 'validation', [{ field: 'reason', message: 'x' }, { field: 'decidedBy', message: 'y' }]), { viewerId: ME, timeText: T }))
      .toEqual({ id: 'M-11', text: problemSummary(2), live: 'assertive', next: 'fix' });
    expect(statusForOutcome(rej(422, 'validation'), { viewerId: ME, timeText: T }))
      .toMatchObject({ id: 'M-11', text: problemSummary(1) });
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

  it('CC-1 contract Error codes: 403 acceptances_required goes to S-05 and 403 must_change_password to S-29, each returning to the question', () => {
    const at = '/orgs/acme/projects/p1/stages/pre-processing/questions/Q-PP-01';
    expect(navigationForOutcome(rej(403, 'acceptances_required'), at)).toEqual({ kind: 'go', href: `/acceptances?callbackUrl=${encodeURIComponent(at)}` });
    expect(navigationForOutcome(rej(403, 'must_change_password'), at)).toEqual({ kind: 'go', href: `/change-password?callbackUrl=${encodeURIComponent(at)}` });
  });

  it('CC-1: a 404 refreshes the page so its own not-found renders, and offers no Retry', () => {
    expect(navigationForOutcome(rej(404, 'not_found'), '/q')).toEqual({ kind: 'refresh' });
  });

  it('CC-1: every other outcome is shown in the status line, the unnamed ones as M-07 with Retry', () => {
    for (const o of [rej(403, 'forbidden'), rej(500, 'x'), rej(429, 'rate_limited'), rej(400, 'bad_request'), rej(401, 'unauthenticated')]) {
      expect(navigationForOutcome(o, '/q')).toBeNull();
    }
    expect(navigationForOutcome({ kind: 'not_saved', reason: 'network' }, '/q')).toBeNull();
    expect(navigationForOutcome({ kind: 'saved', status: 201, body: V1 }, '/q')).toBeNull();
    expect(statusForOutcome(rej(400, 'bad_request'), { viewerId: ME, timeText: T })).toMatchObject({ id: 'M-07', next: 'retry' });
  });

  it('F2 FR-DEC-07 (withdrawal): no reply, a lost reply and a 2xx without a version all say it may have arrived, and Retry is safe', () => {
    const line = DECISION_OUTCOME_COPY.withdraw.maybeArrived;
    expect(WITHDRAW_TEXT.maybeArrived).toBe(line);
    for (const o of [{ kind: 'not_saved', reason: 'timeout' }, { kind: 'not_saved', reason: 'network' }, { kind: 'saved', status: 200, body: {} }] as const) {
      expect(withdrawOutcome(o as SendOutcome<DecisionVersionView>)).toEqual({ kind: 'failed', text: line, retry: true });
    }
    expect(withdrawOutcome({ kind: 'saved', status: 201, body: { ...V2, status: 'withdrawn' } })).toEqual({ kind: 'withdrawn' });
  });

  it('CR-4 FR-DEC-08: a 422 with an empty field list still names a problem on the reason', () => {
    expect(withdrawOutcome({ kind: 'rejected', status: 422, body: { error: 'Choose a withdrawal code.', code: 'validation', fields: [] } }))
      .toEqual({ kind: 'fix', fields: [{ field: 'reason', message: 'Choose a withdrawal code.' }] });
    expect(withdrawOutcome(rej(422, 'validation', [{ field: 'withdrawalCode', message: 'x' }]))).toEqual({ kind: 'fix', fields: [{ field: 'withdrawalCode', message: 'x' }] });
  });

  it('FR-DEC-08: refusals of a withdrawal keep their own lines', () => {
    expect(withdrawOutcome(rej(401, 'unauthenticated'))).toEqual({ kind: 'failed', text: WITHDRAW_TEXT.signedOut, retry: false });
    expect(withdrawOutcome(rej(403, 'forbidden'))).toEqual({ kind: 'failed', text: WITHDRAW_TEXT.forbidden, retry: false });
    expect(withdrawOutcome(rej(409, 'base_version_moved'))).toEqual({ kind: 'failed', text: WITHDRAW_TEXT.moved, retry: false });
    expect(withdrawOutcome(rej(409, 'project_archived'))).toEqual({ kind: 'failed', text: WITHDRAW_TEXT.archived, retry: false });
    expect(withdrawOutcome(rej(500, 'x'))).toEqual({ kind: 'failed', text: WITHDRAW_TEXT.server, retry: true });
  });

  it('FR-DEC-08 (Q18 (b)): a withdrawal\'s 403 acceptances_required says to accept the updated terms first, with the save path\'s terms link', () => {
    const at = '/orgs/acme/projects/p1/stages/pre-processing/questions/Q-PP-01';
    expect(withdrawOutcome(rej(403, 'acceptances_required'), at)).toEqual({
      kind: 'failed', text: WITHDRAW_TEXT.terms, retry: false,
      action: { label: DECISION_OUTCOME_COPY.gate.termsLink, href: `/acceptances?callbackUrl=${encodeURIComponent(at)}` },
    });
    expect(WITHDRAW_TEXT.terms).toBe('Not withdrawn. Accept the updated terms first.');
  });

  it('FR-DEC-08 (Q18 (b)): a withdrawal\'s 403 must_change_password says to change the password first, with the save path\'s password link', () => {
    const at = '/orgs/acme/projects/p1/stages/pre-processing/questions/Q-PP-01';
    expect(withdrawOutcome(rej(403, 'must_change_password'), at)).toEqual({
      kind: 'failed', text: WITHDRAW_TEXT.password, retry: false,
      action: { label: DECISION_OUTCOME_COPY.gate.passwordLink, href: `/change-password?callbackUrl=${encodeURIComponent(at)}` },
    });
    expect(WITHDRAW_TEXT.password).toBe('Not withdrawn. Change your password first.');
  });

  it('FR-DEC-08 (Q18 (b)): a withdrawal\'s 403 forbidden (the role) keeps its line and has no link', () => {
    expect(withdrawOutcome(rej(403, 'forbidden'), '/q')).toEqual({ kind: 'failed', text: WITHDRAW_TEXT.forbidden, retry: false });
    expect(WITHDRAW_TEXT.forbidden).toBe('Not withdrawn. Your role no longer allows this. Ask an Owner or Admin.');
  });

  it('CR-2 ruling 3: with no storage a 403 gate does not navigate by itself; the line says what to do first and links there', () => {
    const at = '/orgs/acme/projects/p1/stages/pre-processing/questions/Q-PP-01';
    const terms = navigationForOutcome(rej(403, 'acceptances_required'), at)!;
    expect(gateStatus(terms as { kind: 'go'; href: string })).toEqual({
      id: 'GATE', text: DECISION_OUTCOME_COPY.gate.terms, live: 'assertive', next: 'go',
      action: { label: DECISION_OUTCOME_COPY.gate.termsLink, href: `/acceptances?callbackUrl=${encodeURIComponent(at)}` },
    });
    const pw = navigationForOutcome(rej(403, 'must_change_password'), at)!;
    expect(gateStatus(pw as { kind: 'go'; href: string })).toMatchObject({
      text: DECISION_OUTCOME_COPY.gate.password, action: { label: DECISION_OUTCOME_COPY.gate.passwordLink, href: `/change-password?callbackUrl=${encodeURIComponent(at)}` },
    });
  });
});

describe('CR-2 rr2: whether a 403 gate may navigate is decided when the reply arrives, from what the device holds then', () => {
  /** A Map-backed Storage whose writes can be refused, as one near its quota refuses a longer value. */
  function quotaStorage(): Storage & { refuse(on: boolean): void } {
    const m = new Map<string, string>();
    let refusing = false;
    return {
      get length() { return m.size; },
      key: (i: number) => [...m.keys()][i] ?? null,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { if (refusing) throw new DOMException('full', 'QuotaExceededError'); m.set(k, String(v)); },
      removeItem: (k: string) => { m.delete(k); },
      clear: () => m.clear(),
      refuse: (on: boolean) => { refusing = on; },
    };
  }
  const NOW = new Date('2026-11-05T09:00:00Z');
  const KEY: DraftKey = { userId: 'u1', orgId: 'o1', projectId: 'p1', target: { kind: 'question', questionId: 'Q-PP-01' } };
  const at = (reason: string, pressed: boolean): StoredDraft<{ reason: string }> => ({
    baseVersionNumber: null, value: { reason }, savedAt: NOW.toISOString(), savePressedAt: pressed ? NOW.toISOString() : null,
    retry: { requestId: null, sentBody: null },
  });

  it('written at the press, a write refused while the save is out, then the 403: the device holds nothing and the form stays', () => {
    const storage = quotaStorage();
    const store = openDraftStore(storage)!;
    expect(store.write(KEY, at('Pressed', true))).toBe(true);          // the press
    storage.refuse(true);
    expect(store.write(KEY, at('A longer reason pasted while saving', false))).toBe(false);   // an edit mid-flight
    expect(store.read(KEY, NOW)).toBeNull();                             // the refused write removed the pressed draft
    expect(draftHeldForGate(store, KEY, at('A longer reason pasted while saving', false), NOW)).toBe(false);
  });

  it('with storage that works when the reply arrives, the field\'s answer is written and read back, and the gate may navigate', () => {
    const storage = quotaStorage();
    const store = openDraftStore(storage)!;
    expect(store.write(KEY, at('Pressed', true))).toBe(true);
    storage.refuse(true);
    store.write(KEY, at('Typed while saving', false));
    storage.refuse(false);                                               // room again by the time the reply comes
    expect(draftHeldForGate(store, KEY, at('Typed while saving', false), NOW)).toBe(true);
    expect(store.read<{ reason: string }>(KEY, NOW)?.value.reason).toBe('Typed while saving');
  });

  it('with no store, the form stays', () => {
    expect(draftHeldForGate(null, KEY, at('Only in the field', true), NOW)).toBe(false);
  });

  it('a write the storage accepts but does not keep reads back as absent, and the form stays', () => {
    const lossy: Storage = { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} };
    expect(draftHeldForGate(openDraftStore(lossy), KEY, at('Not really kept', true), NOW)).toBe(false);
  });
});
