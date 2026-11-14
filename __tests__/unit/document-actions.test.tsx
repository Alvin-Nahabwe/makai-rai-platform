import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IssuedDocumentView } from '@/types/api';
import { HOSTILE_STRINGS } from '../helpers/hostile';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
const { DocumentActions, CopyFallback, WithdrawConfirm, withdrawText, WITHDRAW_LOST, WITHDRAW_OTHER, COPY_LOST } = await import('@/components/documents/DocumentActions');

const doc = (over: Partial<IssuedDocumentView> = {}): IssuedDocumentView => ({
  id: 'd1', projectId: 'p', reviewId: 'r', documentType: 'data_card', sha256: 'ab'.repeat(32), byteSize: 1000,
  issuedBy: { userId: 'u', name: 'Amina N.', formerMember: false }, issuedAt: '2026-11-03T10:42:07.000Z',
  seals: [{ sealId: 's', sealNumber: 1, reviewId: 'r', reviewName: 'Pre-processing review 1', fingerprint: 'c0ffee00'.repeat(8) }],
  withdrawn: null, erased: null, ...over,
});
/** renderToStaticMarkup escapes quotes; the page shows the plain text. */
const plain = (html: string) => html.replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');

describe('DocumentActions', () => {
  it('FR-DOC-07: every issued document offers Copy as text', () => {
    expect(renderToStaticMarkup(<DocumentActions orgSlug="o" document={doc()} canWithdraw={false} />)).toMatch(/<button[^>]*>Copy as text<\/button>/);
    expect(renderToStaticMarkup(<DocumentActions orgSlug="o" document={doc({ withdrawn: { on: '2026-11-04', reason: 'x' } })} canWithdraw={false} />)).toMatch(/>Copy as text</);
  });

  it('FR-DOC-07: a document whose bytes and text were erased offers no copy, since there is no text to copy', () => {
    expect(renderToStaticMarkup(<DocumentActions orgSlug="o" document={doc({ erased: { erasedOn: '2026-11-04' } })} canWithdraw={false} />)).not.toContain('Copy as text');
  });

  it('UX-29 FR-DOC-06: an owner or admin sees a Withdraw document button on a live document', () => {
    expect(renderToStaticMarkup(<DocumentActions orgSlug="o" document={doc()} canWithdraw />)).toMatch(/<button[^>]*>Withdraw document<\/button>/);
  });

  it('UX-29: no Withdraw for a reviewer, and none on a withdrawn document', () => {
    expect(renderToStaticMarkup(<DocumentActions orgSlug="o" document={doc()} canWithdraw={false} />)).not.toContain('Withdraw');
    expect(renderToStaticMarkup(<DocumentActions orgSlug="o" document={doc({ withdrawn: { on: '2026-11-04', reason: 'x' } })} canWithdraw />)).not.toContain('Withdraw document');
  });

  it('NFR-A11Y-06: the copy status is a status region that is present before it has anything to say', () => {
    expect(renderToStaticMarkup(<DocumentActions orgSlug="o" document={doc()} canWithdraw />)).toMatch(/role="status"/);
  });
});

describe('the withdrawal confirmation', () => {
  const confirm = (d: IssuedDocumentView, reason = '') => renderToStaticMarkup(<WithdrawConfirm orgSlug="o" document={d} reason={reason} today="2026-11-04" onDone={() => {}} onCancel={() => {}} />);

  it('UX-29 FR-DOC-06: it names the document, asks for a required reason, and its button repeats the action and is disabled until a reason is typed', () => {
    const html = confirm(doc({ documentType: 'data_card', issuedAt: '2026-11-03T10:42:07.000Z' }));
    expect(html).toContain('Data card issued 3 Nov 2026');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Withdraw document<\/button>/);
    expect(html).toMatch(/<textarea[^>]*required/);
    expect(html).not.toMatch(/>OK</);
    expect(confirm(doc(), 'Wrong committee.')).not.toMatch(/<button[^>]*disabled[^>]*>Withdraw document<\/button>/);
  });

  it('M-36 (owner question B2): the confirmation reads the agreed text, with no code and no checking sentence', () => {
    expect(withdrawText('data_card', '2026-11-04')).toBe("Withdraw data card? It will show 'Withdrawn by the team on 4 Nov 2026'. The document stays stored.");
    expect(withdrawText('mitigation_plan', '2026-11-04')).toBe("Withdraw mitigation plan? It will show 'Withdrawn by the team on 4 Nov 2026'. The document stays stored.");
    const html = plain(confirm(doc({ documentType: 'model_card' })));
    expect(html).toContain(withdrawText('model_card', '2026-11-04'));
    expect(html).toContain('Reason (required)');
    expect(html).toMatch(/>Withdraw document</);
    expect(html).toMatch(/>Cancel</);
    expect(html).not.toContain('Anyone who checks');
    expect(html).not.toMatch(/code/i);
  });
});

describe('the copy fallback', () => {
  it('NFR-SEC-11: the fallback shows hostile text as text', () => {
    const html = renderToStaticMarkup(<CopyFallback text={HOSTILE_STRINGS.join('\n')} />);
    expect(html).toMatch(/<textarea[^>]*readonly/i);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Select all and copy');
  });
});

describe('the failure lines', () => {
  it('UX-27 M-06: a withdrawal that got no reply says it may have arrived and that Retry is safe, and does not say nothing was changed', () => {
    expect(WITHDRAW_LOST).toBe('Not withdrawn yet: no reply from the server. It may have arrived. Retry is safe: it will not withdraw twice.');
    expect(WITHDRAW_LOST).not.toContain('Nothing was changed');
    expect(WITHDRAW_OTHER).toBe('Not withdrawn. Reload the page and try again.');
    expect(COPY_LOST).toBe('Not copied: connection lost.');
  });
});
