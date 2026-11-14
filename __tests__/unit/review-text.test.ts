import { describe, expect, it } from 'vitest';
import {
  SEAL_PROOF_HREF, SEAL_STATUS, contentChangedLine, draftsHref, isReviewBody, isSealBody, openRefusal, previewLines, reviewStateLine, sealAgainLabel, sealRefusal, sealedMessage, unsavedDraftsLine,
} from '@/components/review/reviewText';
import { formatTime } from '@/lib/format/dates';
import { requestIdFor } from '@/lib/client/retrySafeWrite';
import { clearRetry, loadRetry, openRetryKey, retryAfter, saveRetry, sealRetryKey } from '@/components/review/retryStore';
import type { SealView, StageReviewView } from '@/types/api';
import type { SealPreview } from '@/lib/data/reviews';
import { REVIEW_COPY } from '@/lib/review/copy';

/** S-16 and S-17's words (W-7, 7.4.2 row S-16 / S-17, UX-18, M-28), as pure functions. */

const FP = '3f9a1c0e' + 'a'.repeat(52) + '77c1';
const SEAL_VIEW: SealView = {
  id: 's1', reviewId: 'r1', sealNumber: 1, fingerprint: FP, sealedBy: { userId: 'u1', name: 'Grace A.', formerMember: false },
  sealedByRole: 'reviewer', sealedAt: '2026-11-02T07:42:00.000Z', contentSemver: '0.0.1-fixture', bytesMatch: true,
};
const VIEW: StageReviewView = {
  id: 'r1', projectId: 'p1', stage: 'pre-processing', numberInStage: 1, name: 'Pre-processing review 1', preparedFor: 'ethics submission',
  openedBy: { userId: 'u2', name: 'Amina N.', formerMember: false }, openedAt: '2026-10-30T08:00:00.000Z',
  latestSeal: null, changedSinceLatestSeal: false, changed: null, preparedForErased: null, latestSealUnreadable: false,
};
const PREVIEW: SealPreview = {
  byStatus: { done: 8, partly: 3, not_yet: 1, not_applicable: 2 }, byReasonCode: { na_no_personal_data: 2, ny_planned_later: 1 },
  noDecision: ['Q-PP-03', 'Q-PP-05'], doneWithoutEvidence: 2, openFindings: 3, openMitigations: 2, enteredByPeople: 3,
  sealer: { name: 'Grace A.', role: 'reviewer' }, rewordedSinceDecision: 1,
  scopeAnswer: { questionId: 'Q-PP-GATE-SENSITIVE', versionNumber: 1, answer: 'yes' }, evidence: { files: 6, links: 3 },
};
const LABELS = { na_no_personal_data: 'No personal data is involved', ny_planned_later: 'Planned for later' };

describe('review text', () => {
  it('M-28: the sealed message names the number, date, time and short fingerprint', () => {
    const s = { ...SEAL_VIEW, sealNumber: 2, sealedAt: '2026-11-04T08:05:00.000Z', fingerprint: '8b2104fa' + '0'.repeat(52) + '9e3d' };
    expect(sealedMessage(s, 'Africa/Nairobi')).toBe(`Sealed as seal 2 on 4 Nov 2026 at ${formatTime(s.sealedAt, 'Africa/Nairobi')}. Fingerprint 8b21 04fa ... 9e3d.`);
  });

  it('FR-REV-05 NFR-A11Y-05: the review state is said in words', () => {
    expect(reviewStateLine({ ...VIEW, latestSeal: null, changed: null })).toBe(REVIEW_COPY.state.notSealed);
    expect(reviewStateLine({ ...VIEW, latestSeal: { ...SEAL_VIEW, sealNumber: 1, sealedAt: '2026-11-02T07:42:00.000Z', bytesMatch: true }, changed: null })).toBe('Sealed as seal 1 on 2 Nov 2026.');
    expect(reviewStateLine({ ...VIEW, latestSeal: { ...SEAL_VIEW, sealNumber: 1, bytesMatch: true }, changed: { sealNumber: 1, changedQuestions: ['Q-PP-12', 'Q-PP-14'], changedFindings: [] } })).toBe('Changed since seal 1 (2).');
    expect(reviewStateLine({ ...VIEW, latestSeal: { ...SEAL_VIEW, bytesMatch: false }, changed: null })).toBe(REVIEW_COPY.state.damaged);   // SRS 7.5.3 bans "failed"; M-29's sentence
  });

  it('UX-18: the unsaved-answers line, and the statement that sealing records open items', () => {
    expect(unsavedDraftsLine(0)).toBeNull();
    expect(unsavedDraftsLine(1)).toBe(REVIEW_COPY.confirm.unsavedOne);
    const lines = previewLines(PREVIEW, 2, LABELS);
    expect(lines[0]).toBe(REVIEW_COPY.sealPage.statement(2));
    expect(lines).toContain('Decisions by status: Done 8 . Partly 3 . Not yet 1 . Not applicable 2');
    expect(lines).toContain('Not applicable and Not yet by reason: No personal data is involved 2 . Planned for later 1');
    expect(lines).toContain(REVIEW_COPY.sealPage.gateAnswer('Yes'));
    expect(lines).toContain(REVIEW_COPY.sealPage.doneNoEvidence(2));
    expect(lines).toContain('Open findings: 3');
    expect(lines).toContain('Open mitigations: 2');
    expect(lines).toContain(REVIEW_COPY.sealPage.evidence('6 files', '3 links'));
    expect(lines).toContain('Decisions entered by 3 people');
    expect(lines).toContain(REVIEW_COPY.sealPage.reworded(1));
    expect(lines).toContain(REVIEW_COPY.sealPage.sealingAs('Grace A.', 'Reviewer'));
    expect(previewLines({ ...PREVIEW, enteredByPeople: 1, scopeAnswer: null }, 1, LABELS)).toContain('Decisions entered by 1 person');
    expect(previewLines({ ...PREVIEW, scopeAnswer: null }, 1, LABELS).some((l) => l.startsWith(REVIEW_COPY.sealPage.gateAnswer('')))).toBe(false);
  });

  it('UX-18 (7.4.2 S-16 / S-17): the sealing states, the lost-connection line and the path to the next seal read as the SRS', () => {
    expect(SEAL_STATUS).toEqual({ sending: 'Sealing...', slow: 'Still sealing. The connection is slow.', lost: REVIEW_COPY.confirm.lost });   // C4 ruling on hunter H1 (M-06 pattern)
    expect(sealAgainLabel(3)).toBe('Seal again as seal 3');
  });

  it('UX-18 (G023, G050): Go to them opens S-11 with its drafts filter, and the seal link opens What sealing means on Help', () => {
    expect(draftsHref('o', 'p', 'pre-processing')).toBe('/orgs/o/projects/p/stages/pre-processing?show=drafts');
    expect(SEAL_PROOF_HREF).toBe('/help#what-sealing-means');
  });

  it('FR-REV-05 (ruling on RE-5): the question-set line shows only when the running content differs from the seal\'s', () => {
    expect(contentChangedLine({ ...SEAL_VIEW, sealNumber: 1, contentSemver: '0.0.1-fixture' }, '0.0.2-fixture'))
      .toBe(REVIEW_COPY.state.contentChanged(1));
    expect(contentChangedLine({ ...SEAL_VIEW, contentSemver: '0.0.2-fixture' }, '0.0.2-fixture')).toBeNull();
    expect(contentChangedLine(null, '0.0.2-fixture')).toBeNull();
  });

  it('FR-REV-06 (C4 SF-1 ruling): a latest seal whose bytes are no readable manifest of it reads M-29, even when its fingerprint matches', () => {
    expect(reviewStateLine({ ...VIEW, latestSeal: { ...SEAL_VIEW, bytesMatch: true }, latestSealUnreadable: true, changed: null })).toBe(REVIEW_COPY.state.damaged);
  });

  it('UX-25 (C4 CR-1, CR-4, SF-5): S-17 says every refusal once, with Retry only where retrying can help', () => {
    const r = (status: number, code: string, extra: Record<string, unknown> = {}) => ({ status, body: { error: 'x', code, ...extra } });
    expect(sealRefusal(r(409, 'number_taken'), 2)).toEqual({
      message: REVIEW_COPY.confirm.numberTaken(2), retry: false, refresh: true,
    });
    expect(sealRefusal(r(401, 'unauthenticated'), 1)).toEqual({ message: REVIEW_COPY.confirm.signedOut, retry: false, refresh: false });
    expect(sealRefusal(r(429, 'rate_limited', { retryAfterSeconds: 90 }), 1)).toEqual({ message: REVIEW_COPY.confirm.rateLimited(REVIEW_COPY.waitMany(2)), retry: false, refresh: false });
    expect(sealRefusal(r(429, 'rate_limited'), 1).message).toBe(REVIEW_COPY.confirm.rateLimited(REVIEW_COPY.waitOne));
    expect(sealRefusal(r(409, 'project_archived'), 1)).toMatchObject({ message: REVIEW_COPY.confirm.archived, retry: false });   // C4 CR-6 ruling
    expect(sealRefusal(r(403, 'forbidden'), 1).message).toBe(REVIEW_COPY.confirm.roleChanged);
    expect(openRefusal(r(403, 'forbidden')).message).toBe(REVIEW_COPY.open.roleChanged);
    expect(openRefusal(r(409, 'project_archived')).message).toBe(REVIEW_COPY.open.archived);
    expect(sealRefusal(r(403, 'forbidden'), 1).retry).toBe(false);
    expect(sealRefusal(r(500, 'internal_error'), 1)).toEqual({ message: REVIEW_COPY.confirm.server, retry: true, refresh: false });
    expect(sealRefusal(r(404, 'not_found'), 1).retry).toBe(false);
  });

  it('UX-25 (C4 CR-4): the open form says a sign-out and a rate limit, and never offers a retry that cannot work', () => {
    const r = (status: number, code: string, extra: Record<string, unknown> = {}) => ({ status, body: { error: 'x', code, ...extra } });
    expect(openRefusal(r(401, 'unauthenticated'))).toEqual({ message: REVIEW_COPY.open.signedOut, retry: false, refresh: false });
    expect(openRefusal(r(429, 'rate_limited', { retryAfterSeconds: 30 })).message).toBe(REVIEW_COPY.open.rateLimited(REVIEW_COPY.waitOne));
    expect(openRefusal(r(409, 'number_taken'))).toMatchObject({ refresh: true, retry: false });
    expect(openRefusal(r(500, 'internal_error'))).toEqual({ message: REVIEW_COPY.open.server, retry: true, refresh: false });
  });

  it('UX-25 (S-17 hunt H2, H3): a 2xx body that is not a seal or a review is not trusted, and only forbidden reads as a lowered role', () => {
    expect(isSealBody({ ...SEAL_VIEW, sealNumber: 3 })).toBe(true);
    for (const bad of [null, {}, { ...SEAL_VIEW, fingerprint: 'abc' }, { ...SEAL_VIEW, sealNumber: '3' }, 'text']) expect(isSealBody(bad)).toBe(false);
    expect(isReviewBody(VIEW)).toBe(true);
    for (const bad of [null, {}, { id: 7 }, { id: '' }]) expect(isReviewBody(bad)).toBe(false);
    const r = (status: number, code: string) => ({ status, body: { error: 'x', code } });
    expect(sealRefusal(r(403, 'must_change_password'), 1).message).not.toContain(REVIEW_COPY.confirm.roleChanged);
    expect(sealRefusal(r(403, 'cross_origin'), 1).message).not.toContain(REVIEW_COPY.confirm.roleChanged);
    expect(openRefusal(r(403, 'must_change_password')).message).not.toContain(REVIEW_COPY.open.roleChanged);
    expect(sealRefusal(r(403, 'forbidden'), 1).message).toContain(REVIEW_COPY.confirm.roleChanged);
  });

  it('FR-DEC-07 (C4 ruling on hunter H1): the request id of a lost seal or open survives a reload, until a 201 or a 200 clears it', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
    const first = requestIdFor(loadRetry(storage, sealRetryKey('u1', 'r1')), {}).state;
    saveRetry(storage, sealRetryKey('u1', 'r1'), first);
    const afterReload = requestIdFor(loadRetry(storage, sealRetryKey('u1', 'r1')), {});   // a new page load reads the stored state
    expect(afterReload.requestId).toBe(first.requestId);
    expect(loadRetry(storage, sealRetryKey('u1', 'r2'))).toEqual({ requestId: null, sentBody: null });   // per review
    clearRetry(storage, sealRetryKey('u1', 'r1'));
    expect(loadRetry(storage, sealRetryKey('u1', 'r1'))).toEqual({ requestId: null, sentBody: null });
    // The open form: the id is reused only for the same stage and note (requestIdFor's rule).
    const open = requestIdFor(loadRetry(storage, openRetryKey('u1', 'p1')), { stage: 'pre-processing', preparedFor: null }).state;
    saveRetry(storage, openRetryKey('u1', 'p1'), open);
    expect(requestIdFor(loadRetry(storage, openRetryKey('u1', 'p1')), { stage: 'pre-processing', preparedFor: null }).requestId).toBe(open.requestId);
    expect(requestIdFor(loadRetry(storage, openRetryKey('u1', 'p1')), { stage: 'in-processing', preparedFor: null }).requestId).not.toBe(open.requestId);
    // A damaged or missing storage is no stored state, never a throw.
    data.set(sealRetryKey('u1', 'r3'), '{not json');
    expect(loadRetry(storage, sealRetryKey('u1', 'r3'))).toEqual({ requestId: null, sentBody: null });
    expect(loadRetry(null, sealRetryKey('u1', 'r1'))).toEqual({ requestId: null, sentBody: null });
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(loadRetry(throwing, sealRetryKey('u1', 'r1'))).toEqual({ requestId: null, sentBody: null });
    expect(() => { saveRetry(throwing, sealRetryKey('u1', 'r1'), first); clearRetry(throwing, sealRetryKey('u1', 'r1')); }).not.toThrow();
  });

  it('FR-DEC-07 (C4 round 3, F1): the stored id is per signed-in account, so another account in the same tab never sends it', () => {
    expect(sealRetryKey('u1', 'r1')).not.toBe(sealRetryKey('u2', 'r1'));
    expect(openRetryKey('u1', 'p1')).not.toBe(openRetryKey('u2', 'p1'));
    expect(sealRetryKey('u1', 'r1')).toContain('u1');
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
    const a = requestIdFor({ requestId: null, sentBody: null }, {}).state;
    saveRetry(storage, sealRetryKey('userA', 'r1'), a);   // A's seal landed and its reply was lost
    const b = requestIdFor(loadRetry(storage, sealRetryKey('userB', 'r1')), {});   // B signs in in the same tab
    expect(b.requestId).not.toBe(a.requestId);
  });

  it('FR-DEC-07 (C4 round 3, F2): after a reply the stored id is cleared on a seal or review, on number_taken and on request_id_reused, and kept otherwise', () => {
    expect(retryAfter({ kind: 'saved', bodyOk: true })).toBe('clear');               // 201, or a 200 replay
    expect(retryAfter({ kind: 'saved', bodyOk: false })).toBe('keep');               // a 2xx that is not the object: may have been written
    expect(retryAfter({ kind: 'not_saved' })).toBe('keep');                          // a lost reply or timeout
    expect(retryAfter({ kind: 'rejected', status: 409, code: 'number_taken' })).toBe('clear');
    expect(retryAfter({ kind: 'rejected', status: 409, code: 'request_id_reused' })).toBe('clear');
    expect(retryAfter({ kind: 'rejected', status: 500, code: 'internal_error' })).toBe('keep');
    expect(retryAfter({ kind: 'rejected', status: 403, code: 'forbidden' })).toBe('keep');
  });

  it('FR-DEC-07 (C4 round 3, F3): a stored requestId that is not a UUID is nothing stored', () => {
    const data = new Map<string, string>([[sealRetryKey('u1', 'r9'), JSON.stringify({ requestId: 'not-a-uuid', sentBody: '{}' })]]);
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
    expect(loadRetry(storage, sealRetryKey('u1', 'r9'))).toEqual({ requestId: null, sentBody: null });
    data.set(sealRetryKey('u1', 'r8'), JSON.stringify({ requestId: '6F1D2C3A-1B2C-4D5E-8F90-123456789ABC', sentBody: '{}' }));
    expect(loadRetry(storage, sealRetryKey('u1', 'r8')).requestId).toBe('6F1D2C3A-1B2C-4D5E-8F90-123456789ABC');
  });
});
