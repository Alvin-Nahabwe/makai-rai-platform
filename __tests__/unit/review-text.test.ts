import { describe, expect, it } from 'vitest';
import {
  SEAL_PROOF_HREF, SEAL_STATUS, contentChangedLine, draftsHref, openRefusal, previewLines, reviewStateLine, sealAgainLabel, sealRefusal, sealedMessage, unsavedDraftsLine,
} from '@/components/review/reviewText';
import { formatTime } from '@/lib/format/dates';
import type { SealView, StageReviewView } from '@/types/api';
import type { SealPreview } from '@/lib/data/reviews';

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
    expect(reviewStateLine({ ...VIEW, latestSeal: null, changed: null })).toBe('Never sealed.');
    expect(reviewStateLine({ ...VIEW, latestSeal: { ...SEAL_VIEW, sealNumber: 1, sealedAt: '2026-11-02T07:42:00.000Z', bytesMatch: true }, changed: null })).toBe('Sealed as seal 1 on 2 Nov 2026.');
    expect(reviewStateLine({ ...VIEW, latestSeal: { ...SEAL_VIEW, sealNumber: 1, bytesMatch: true }, changed: { sealNumber: 1, changedQuestions: ['Q-PP-12', 'Q-PP-14'], changedFindings: [] } })).toBe('Changed since seal 1 (2).');
    expect(reviewStateLine({ ...VIEW, latestSeal: { ...SEAL_VIEW, bytesMatch: false }, changed: null })).toBe('Does not match the record.');   // SRS 7.5.3 bans "failed"; M-29's sentence
  });

  it('UX-18: the unsaved-answers line, and the statement that sealing records open items', () => {
    expect(unsavedDraftsLine(0)).toBeNull();
    expect(unsavedDraftsLine(1)).toBe('You have 1 unsaved answers in this stage on this device. They will not be in the seal.');
    const lines = previewLines(PREVIEW, 2, LABELS);
    expect(lines[0]).toBe('A seal fixes what the record says right now, gaps included. It does not hide open items; it records them. After sealing, any change shows as "changed since seal 2".');
    expect(lines).toContain('Decisions by status: Done 8 . Partly 3 . Not yet 1 . Not applicable 2');
    expect(lines).toContain('Not applicable and Not yet by reason: No personal data is involved 2 . Planned for later 1');
    expect(lines).toContain('Scope answer: Yes (Q-PP-GATE-SENSITIVE, version 1)');
    expect(lines).toContain('Done without evidence: 2');
    expect(lines).toContain('Open findings: 3');
    expect(lines).toContain('Open mitigations: 2');
    expect(lines).toContain('Evidence: 6 files (fingerprints taken of each file), 3 links (the address only; the platform never opens links)');
    expect(lines).toContain('Decisions entered by 3 people');
    expect(lines).toContain('Expected practice reworded since the decision: 1');
    expect(lines).toContain('You are sealing as Grace A. (reviewer)');
    expect(previewLines({ ...PREVIEW, enteredByPeople: 1, scopeAnswer: null }, 1, LABELS)).toContain('Decisions entered by 1 person');
    expect(previewLines({ ...PREVIEW, scopeAnswer: null }, 1, LABELS).some((l) => l.startsWith('Scope answer'))).toBe(false);
  });

  it('UX-18 (7.4.2 S-16 / S-17): the sealing states, the lost-connection line and the path to the next seal read as the SRS', () => {
    expect(SEAL_STATUS).toEqual({ sending: 'Sealing...', slow: 'Still sealing. The connection is slow.', lost: 'Not sealed: connection lost. Nothing was sealed.' });
    expect(sealAgainLabel(3)).toBe('Seal again as seal 3');
  });

  it('UX-18 (G023, G050): Go to them opens S-11 with its drafts filter, and What a seal proves opens its About anchor', () => {
    expect(draftsHref('o', 'p', 'pre-processing')).toBe('/orgs/o/projects/p/stages/pre-processing?show=drafts');
    expect(SEAL_PROOF_HREF).toBe('/about#what-a-seal-proves');
  });

  it('FR-REV-05 (ruling on RE-5): the question-set line shows only when the running content differs from the seal\'s', () => {
    expect(contentChangedLine({ ...SEAL_VIEW, sealNumber: 1, contentSemver: '0.0.1-fixture' }, '0.0.2-fixture'))
      .toBe('The question set changed after seal 1 (version 0.0.1-fixture to 0.0.2-fixture). Changes are counted against the current question set.');
    expect(contentChangedLine({ ...SEAL_VIEW, contentSemver: '0.0.2-fixture' }, '0.0.2-fixture')).toBeNull();
    expect(contentChangedLine(null, '0.0.2-fixture')).toBeNull();
  });

  it('FR-REV-06 (C4 SF-1 ruling): a latest seal whose bytes are no readable manifest of it reads M-29, even when its fingerprint matches', () => {
    expect(reviewStateLine({ ...VIEW, latestSeal: { ...SEAL_VIEW, bytesMatch: true }, latestSealUnreadable: true, changed: null })).toBe('Does not match the record.');
  });

  it('UX-25 (C4 CR-1, CR-4, SF-5): S-17 says every refusal once, with Retry only where retrying can help', () => {
    const r = (status: number, code: string, extra: Record<string, unknown> = {}) => ({ status, body: { error: 'x', code, ...extra } });
    expect(sealRefusal(r(409, 'number_taken'), 2)).toEqual({
      message: 'Not sealed: seal 2 was taken by someone else just now. Nothing was sealed by this press. The next seal is seal 3.', retry: false, refresh: true,
    });
    expect(sealRefusal(r(401, 'unauthenticated'), 1)).toEqual({ message: 'Not sealed: you have been signed out. Sign in again to seal.', retry: false, refresh: false });
    expect(sealRefusal(r(429, 'rate_limited', { retryAfterSeconds: 90 }), 1)).toEqual({ message: 'Not sealed: too many requests. Wait 2 minutes, then retry.', retry: false, refresh: false });
    expect(sealRefusal(r(429, 'rate_limited'), 1).message).toBe('Not sealed: too many requests. Wait 1 minute, then retry.');
    expect(sealRefusal(r(409, 'project_archived'), 1)).toMatchObject({ message: 'Not saved: this project is archived. Owners and admins can unarchive it.', retry: false });
    expect(sealRefusal(r(403, 'forbidden'), 1).retry).toBe(false);
    expect(sealRefusal(r(500, 'internal_error'), 1)).toEqual({ message: 'Not sealed: the server had a problem. Nothing was sealed.', retry: true, refresh: false });
    expect(sealRefusal(r(404, 'not_found'), 1).retry).toBe(false);
  });

  it('UX-25 (C4 CR-4): the open form says a sign-out and a rate limit, and never offers a retry that cannot work', () => {
    const r = (status: number, code: string, extra: Record<string, unknown> = {}) => ({ status, body: { error: 'x', code, ...extra } });
    expect(openRefusal(r(401, 'unauthenticated'))).toEqual({ message: 'Not opened: you have been signed out. Sign in again.', retry: false, refresh: false });
    expect(openRefusal(r(429, 'rate_limited', { retryAfterSeconds: 30 })).message).toBe('Not opened: too many requests. Wait 1 minute, then retry.');
    expect(openRefusal(r(409, 'number_taken'))).toMatchObject({ refresh: true, retry: false });
    expect(openRefusal(r(500, 'internal_error'))).toEqual({ message: 'Not opened: the server had a problem. Retry.', retry: true, refresh: false });
  });
});
