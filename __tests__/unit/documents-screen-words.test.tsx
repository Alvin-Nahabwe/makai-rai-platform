import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IssuedDocumentView } from '@/types/api';
import type { SendOutcome } from '@/lib/client/retrySafeWrite';
import { DOCUMENTS_COPY, MSG_ISSUE_NO_REPLY, MSG_PREVIEW_SERVER, MSG_ROLE_CHANGED, MSG_SEAL_CHECK_FAILED, SEAL_CHECK_FAILED } from '@/lib/documents/copy';
import { generateReducer, type GenerateState } from '@/lib/documents/generate';
import { GenerateDocumentForm, NeverSealed, fromRecordLine, issuedMessage } from '@/components/documents/GenerateDocumentForm';
import { IssuedDocumentsList } from '@/components/documents/IssuedDocumentsList';
import { ReviewDocumentsList } from '@/components/documents/ReviewDocumentsList';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
const A = await import('@/components/documents/DocumentActions');

/**
 * The ruled words of S-18 (plan 1A Task 18c (c)), each pinned word for word: the copy audit's RULED TEXT (task-18-map-copy.md, 18c
 * table) with the lead's rulings ("Generate" retired; failures say "Preview not shown." or "Not issued."; S-Q2 punctuation).
 */
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const doc = (over: Partial<IssuedDocumentView> = {}): IssuedDocumentView => ({
  id: 'doc-1', projectId: 'p', reviewId: 'r', documentType: 'data_card', sha256: SHA, byteSize: 84000,
  issuedBy: { userId: 'u', name: 'Amina N.', formerMember: false }, issuedAt: '2026-11-03T10:42:07.000Z',
  seals: [{ sealId: 's', sealNumber: 1, reviewId: 'r', reviewName: 'Pre-processing review 1', fingerprint: SHA }], withdrawn: null, erased: null, ...over,
});
const seal = (n: number, over: Partial<{ latest: boolean; bytesMatch: boolean }> = {}) => ({
  sealId: `s${n}`, sealNumber: n, reviewId: 'r', reviewName: 'Pre-processing review 1', sealedAt: `2026-11-0${n}T09:00:00.000Z`, latest: false, bytesMatch: true, ...over,
});
const form = (over: { neverSealed?: Array<'pre-processing' | 'in-processing' | 'post-processing'>; seals?: ReturnType<typeof seal>[] } = {}) => ({
  orgSlug: 'o', projectId: 'p', reviewId: 'r', seals: over.seals ?? [seal(1, { latest: true })],
  documents: [{
    type: 'data_card' as const, title: 'Data card', help: 'Help.', neverSealedStages: over.neverSealed ?? [],
    typedFields: [{ fieldId: 'DC-25', label: 'Licence' }], draft: {}, fromRecord: { fields: 35, questions: 20, notRecorded: 12 },
  }],
});
const rejected = (status: number, code: string, fields?: Array<{ field: string; message: string }>): SendOutcome<unknown> =>
  ({ kind: 'rejected', status, body: { error: 'x', code, ...(fields === undefined ? {} : { fields }) } });
const start: GenerateState = { phase: 'editing', typed: {}, message: null, retry: false };
const previewing = generateReducer(start, { kind: 'send' });
const issuing = generateReducer(start, { kind: 'send', to: 'issuing' });
const after = (s: GenerateState, o: SendOutcome<unknown>) => generateReducer(s, { kind: 'outcome', outcome: o });

describe('S-18 words (plan 1A Task 18c (c))', () => {
  it('the page, the form and the preview', () => {
    expect(DOCUMENTS_COPY.page.heading).toBe('Create a document');
    expect(DOCUMENTS_COPY.page.chooseHeading).toBe('Choose a document');
    expect(DOCUMENTS_COPY.page.issuedHeading).toBe('Issued documents');
    expect(MSG_SEAL_CHECK_FAILED).toBe('This seal cannot be used because it no longer matches the record. Contact MAK-AI through Help and contact.');
    expect(renderToStaticMarkup(<NeverSealed orgSlug="o" projectId="p" reviewId="r" />)).toContain('Seal this review first. Documents are made from a sealed review.');
    const html = renderToStaticMarkup(<GenerateDocumentForm {...form()} />);
    expect(html).toMatch(/<legend[^>]*>Choose a document<\/legend>/);
    expect(html).toContain('Data card: fields to type in');
    expect(html).toContain('Type these for this document only. They are not part of the sealed record. The platform keeps what you type for next time. Leave a field empty to print &quot;Not recorded&quot;.');
    expect(html).toContain('>Make it from seal<');
    expect(html).toMatch(/>Preview document</);
    expect(html).not.toMatch(/Generat/);
    expect(issuedMessage({ sha256: SHA, byteSize: 1 })).toBe('Issued. Fingerprint a1b2 c3d4 ... 8f90.');
    expect(DOCUMENTS_COPY.issued.another).toBe('Create another document');
    expect(DOCUMENTS_COPY.preview.heading('Data card')).toBe('Preview: Data card');
    expect(DOCUMENTS_COPY.preview.nothingSaved).toBe('Nothing is saved until you select Issue this document.');
  });

  it('the seal options, the unsealed stages by name, and the plural at one', () => {
    const html = renderToStaticMarkup(<GenerateDocumentForm {...form({ seals: [seal(1, { bytesMatch: false }), seal(2, { latest: true })] })} />);
    expect(html).toMatch(/<option[^>]*disabled[^>]*>Seal 1, 1 Nov 2026: cannot be used<\/option>/);
    expect(html).toMatch(/<option[^>]*>Seal 2, 2 Nov 2026 \(latest\)<\/option>/);
    expect(SEAL_CHECK_FAILED).toBe('Cannot be used');
    expect(renderToStaticMarkup(<GenerateDocumentForm {...form({ neverSealed: ['in-processing'] })} />))
      .toContain('Part of this document comes from the In-processing stage, which has not been sealed. Those fields will read &quot;Not recorded: this stage had no seal when the document was issued&quot;.');
    expect(renderToStaticMarkup(<GenerateDocumentForm {...form({ neverSealed: ['in-processing', 'post-processing'] })} />))
      .toContain('Part of this document comes from the In-processing and Post-processing stages, which have not been sealed. Those fields will read &quot;Not recorded: this stage had no seal when the document was issued&quot;.');
    expect(fromRecordLine({ fields: 1, questions: 1, notRecorded: 1 })).toBe('1 field from 1 question\u00a0· 1 field will read "Not recorded"');
    expect(fromRecordLine({ fields: 10, questions: 0, notRecorded: 2 })).toBe('10 fields\u00a0· 2 fields will read "Not recorded"');
  });

  it('the status lines and the refusals of the two phases', () => {
    expect(previewing.message).toBe('Making the preview...');
    expect(issuing.message).toBe('Issuing the document...');
    expect(generateReducer(previewing, { kind: 'slow' }).message).toBe('Still making the preview.');
    expect(generateReducer(issuing, { kind: 'slow' }).message).toBe('Still issuing the document.');
    expect(after(previewing, { kind: 'not_saved', reason: 'network' }).message).toBe('Preview not shown. Connection lost. Nothing was issued.');
    expect(after(previewing, rejected(500, 'internal_error')).message).toBe('Preview not shown. The server had a problem. Try again.');
    expect(MSG_PREVIEW_SERVER).toBe('Preview not shown. The server had a problem. Try again.');
    expect(after(previewing, rejected(409, 'project_archived')).message).toBe('Preview not shown. This project is archived. Owners and Admins can unarchive it.');
    expect(after(issuing, rejected(409, 'project_archived')).message).toBe('Not issued. This project is archived. Owners and Admins can unarchive it.');
    expect(after(issuing, rejected(403, 'forbidden')).message).toBe('Not issued. Your role in this organisation no longer allows this. Ask an Owner or Admin.');
    expect(MSG_ROLE_CHANGED).toBe('Preview not shown. Your role in this organisation no longer allows this. Ask an Owner or Admin.');
    expect(after(previewing, rejected(401, 'unauthenticated')).message).toBe('Preview not shown. You are signed out. Sign in again, then come back. Nothing was issued.');
    expect(after(issuing, rejected(409, 'x')).message).toBe('Not issued. Something went wrong. Nothing was issued. Please try again.');
    expect(after(previewing, { kind: 'rejected', status: 429, body: { error: 'x', code: 'rate_limited', retryAfterSeconds: 60 } }).message).toBe('Preview not shown. Too many attempts. Try again in 1 minute.');
    expect(after(previewing, { kind: 'rejected', status: 429, body: { error: 'x', code: 'rate_limited', retryAfterSeconds: 120 } }).message).toBe('Preview not shown. Too many attempts. Try again in 2 minutes.');
    expect(after(issuing, { kind: 'not_saved', reason: 'network' }).message).toBe(MSG_ISSUE_NO_REPLY);
  });

  it('a server field message the screen knows is shown; one it does not know never is', () => {
    expect(after(previewing, rejected(422, 'validation', [{ field: 'typedFields.DC-25', message: 'Use at most 2000 characters.' }]))).toMatchObject({
      message: 'Preview not shown. Use at most 2000 characters.', refused: [{ fieldId: 'DC-25', message: 'Use at most 2000 characters.' }],
    });
    expect(after(previewing, rejected(422, 'validation', [{ field: 'sealId', message: MSG_SEAL_CHECK_FAILED }])).message).toBe(`Preview not shown. ${MSG_SEAL_CHECK_FAILED}`);
    const unknown = after(issuing, rejected(422, 'validation', [{ field: 'requestId', message: 'requestId must be a UUID (8-4-4-4-12 hexadecimal).' }]));
    expect(unknown.message).toBe('Not issued. Reload the page and try again.');
    const raw = after(previewing, rejected(422, 'validation', [{ field: 'typedFields.DC-25', message: '<b>raw</b>' }]));
    expect(raw.message).toBe('Preview not shown. Reload the page and try again.');
    expect(raw.refused).toBeUndefined();
    expect(DOCUMENTS_COPY.fieldMessages.chooseEthics).toBe('Choose Approval granted, Submitted or Not required.');
  });

  it('the issued list and the S-16 slot', () => {
    const html = renderToStaticMarkup(<IssuedDocumentsList orgSlug="o" documents={[doc()]} latestSealNumber={2} canWithdraw />);
    expect(html).toContain('Data card\u00a0· seal 1\u00a0· 3 Nov 2026\u00a0· by Amina N.\u00a0· Fingerprint a1b2 c3d4 ... 8f90');
    expect(html).toContain('Made from an older seal. A newer seal exists.');
    expect(renderToStaticMarkup(<IssuedDocumentsList orgSlug="o" documents={[doc({ erased: { erasedOn: '2026-11-04' } })]} latestSealNumber={1} canWithdraw />)).toContain('File erased on 4 Nov 2026');
    expect(renderToStaticMarkup(<ReviewDocumentsList orgSlug="o" projectId="p" reviewId="r" documents={[doc()]} />))
      .toContain('Data card\u00a0· from seal 1\u00a0· issued 3 Nov 2026\u00a0· Fingerprint a1b2 c3d4 ... 8f90\u00a0· Issued');
  });

  it('copy and withdraw', () => {
    expect(A.withdrawText('data_card', '2026-11-04')).toBe('Withdraw this data card? It will be marked Withdrawn in the list, with your reason. The PDF is kept and can still be downloaded.');
    expect([A.COPY_LOST, A.COPY_SIGNED_OUT, A.COPY_ERASED, A.COPY_TOO_MANY, A.COPY_OTHER]).toEqual([
      'Not copied. Connection lost.', 'Not copied. You are signed out. Sign in again, then come back.', "Not copied. This document's text was erased.",
      'Not copied. Too many requests. Wait a minute, then try again.', 'Not copied. Reload the page and try again.',
    ]);
    expect([A.WITHDRAW_TAKEN, A.WITHDRAW_SIGNED_OUT, A.WITHDRAW_EARLIER, A.WITHDRAW_UNCONFIRMED, A.WITHDRAW_FORBIDDEN, A.WITHDRAW_ARCHIVED]).toEqual([
      'Not withdrawn by you. Someone else withdrew it first. Their reason is shown.', 'Not withdrawn. You are signed out. Sign in again, then come back.',
      'Withdrawn. Your earlier request may have done it. The reason shown is the one recorded.', 'Not confirmed. It may already have been withdrawn. Reload the page to see.',
      'Not withdrawn. Your role in this organisation no longer allows this. Ask an Owner or Admin.', 'Not withdrawn. This project is archived. Owners and Admins can unarchive it.',
    ]);
    expect(A.WITHDRAW_LOST).toBe(DOCUMENTS_COPY.actions.withdrawLost);
  });
});
