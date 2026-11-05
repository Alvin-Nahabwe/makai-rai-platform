import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocumentType } from '@/types/record';
import type { IssuedDocumentView } from '@/types/api';
import {
  GenerateDocumentForm, GenerateStatus, TypedGroup, NEVER_SEALED_LINE, NO_DOCUMENTS_LINE, NeverSealed, PreviewPane, generateReducer, issuedMessage, olderSealLine,
  submitIssue, type GenerateState,
} from '@/components/documents/GenerateDocumentForm';
import { IssuedDocumentsList } from '@/components/documents/IssuedDocumentsList';
import { ReviewDocumentsList } from '@/components/documents/ReviewDocumentsList';
import { SLOW_MS, type SendOutcome, type sendWrite } from '@/lib/client/retrySafeWrite';
import { SEALED_NOTE, STATEMENT, TYPED_MARK } from '@/lib/documents/copy';
import { formatFingerprint } from '@/lib/seal/format';
import { HOSTILE_STRINGS } from '../helpers/hostile';

const HELP: Record<DocumentType, string> = {
  data_card: 'Fixture help for the data card: describe the data the system learns from.',
  model_card: 'Fixture help for the model card: describe what the model does and where it stops working.',
  mitigation_plan: 'Fixture help for the mitigation plan: list each finding and what the team will do about it.',
};
const TITLES: Record<DocumentType, string> = { data_card: 'Data card', model_card: 'Model card', mitigation_plan: 'Mitigation plan' };
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const seal = (n: number, over: Partial<{ latest: boolean; bytesMatch: boolean }> = {}) => ({
  sealId: `s${n}`, sealNumber: n, reviewId: 'r', reviewName: 'Pre-processing review 1', sealedAt: `2026-11-0${n}T09:00:00.000Z`, latest: false, bytesMatch: true, ...over,
});
function props(over: { preparedFor?: string | null; draft?: Record<string, string>; notRecorded?: number; neverSealed?: Array<'pre-processing' | 'in-processing' | 'post-processing'>; seals?: ReturnType<typeof seal>[] } = {}) {
  return {
    orgSlug: 'o', projectId: 'p', reviewId: 'r', seals: over.seals ?? [seal(1, { latest: true })],
    documents: (['data_card', 'model_card', 'mitigation_plan'] as const).map((type) => ({
      type, title: TITLES[type], help: HELP[type], neverSealedStages: over.neverSealed ?? [],
      typedFields: type === 'data_card' ? [{ fieldId: 'DC-25', label: 'Licence' }, { fieldId: 'DC-15', label: 'Ethics review', structured: 'ethics_approval' as const }] : [{ fieldId: `${type}-x`, label: 'A typed field' }],
      draft: type === 'data_card' ? (over.draft ?? {}) : {},
      fromRecord: type === 'mitigation_plan' ? null : { fields: 35, questions: 20, notRecorded: over.notRecorded ?? 12 },
    })),
  };
}
const doc = (over: Partial<{ sealNumber: number; byteSize: number }> = {}): IssuedDocumentView => ({
  id: 'doc-12345678', projectId: 'p', reviewId: 'r', documentType: 'data_card', sha256: SHA, byteSize: over.byteSize ?? 84000,
  issuedBy: { userId: 'u', name: 'Amina N.', formerMember: false }, issuedAt: '2026-11-03T10:42:07.000Z',
  seals: [{ sealId: 's', sealNumber: over.sealNumber ?? 1, reviewId: 'r', reviewName: 'Pre-processing review 1', fingerprint: SHA }], withdrawn: null, erased: null,
});
const decodeEntities = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

describe('S-18 form', () => {
  it.each([null, 'UNCST protocol submission', 'NeurIPS datasets track', 'publication'])(
    'FR-DOC-01 UX-20: for the note %s S-18 lists data card, model card, mitigation plan in that order, each with its help line', (note) => {
      const html = renderToStaticMarkup(<GenerateDocumentForm {...props({ preparedFor: note })} />);
      const at = ['Data card', 'Model card', 'Mitigation plan'].map((t) => html.indexOf(`>${t}<`));
      expect(at.every((x) => x > 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      for (const help of Object.values(HELP)) expect(html).toContain(help);
    });

  it('UX-20 FR-DOC-03: typed fields carry the mark and the draft values, and the summary says how many fields read Not recorded', () => {
    const html = renderToStaticMarkup(<GenerateDocumentForm {...props({ draft: { 'DC-25': 'CC BY 4.0' }, notRecorded: 3 })} />);
    expect(html).toContain(TYPED_MARK);
    expect(html).toContain('value="CC BY 4.0"');
    expect(html).toMatch(/3 fields will read &quot;Not recorded&quot;/);
    expect(html).toMatch(/35 fields from 20 questions/);
  });

  it('UX-20: the radio group is a fieldset with a legend, each radio is described by its help line, and the ethics review has its sub-fields', () => {
    const html = renderToStaticMarkup(<GenerateDocumentForm {...props()} />);
    expect(html).toMatch(/<fieldset[^>]*>\s*<legend[^>]*>Documents<\/legend>/);
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html.match(/<input[^>]*type="radio"[^>]*aria-describedby="[^"]+"/g)).toHaveLength(3);
    expect(html).toMatch(/<select[^>]*>[\s\S]*Approval granted[\s\S]*<\/select>/);
    expect(html).toContain('Leave empty to print &quot;Not recorded&quot;');
  });

  it('FR-DOC-05 UX-20: a document needing a stage never sealed says so before generating', () => {
    expect(renderToStaticMarkup(<GenerateDocumentForm {...props({ neverSealed: ['in-processing'] })} />)).toContain('Not recorded at the time of issue');
  });

  it('NFR-SEC-11 UX-20: the preview shows hostile text as text', () => {
    const html = renderToStaticMarkup(<PreviewPane text={HOSTILE_STRINGS.join('\n')} />);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('FR-PUB-01 FR-DOC-02 (SRS 7.5.3 AL-1): the preview wraps the AL-1 sentence, and only that line, in a data-claims-allowed element whose reason names AL-1', () => {
    const text = ['Data card', 'DC-01 Purpose', 'Two coders labelled every visit.', STATEMENT, SEALED_NOTE].join('\n');
    const html = renderToStaticMarkup(<PreviewPane text={text} />);
    const marked = [...html.matchAll(/<(\w+)[^>]*\sdata-claims-allowed="([^"]+)"[^>]*>([^<]*)<\/\1>/g)];
    expect(marked).toHaveLength(1);
    expect(marked[0][2]).toMatch(/^AL-1\b/);
    expect(decodeEntities(marked[0][3])).toBe(STATEMENT);
    const rest = html.replace(marked[0][0], '');
    expect(rest).not.toMatch(/\bcomplian(ce|t)\b|\baudit|\bcertif|\bscores?\b/i);
    expect(renderToStaticMarkup(<PreviewPane text="a typed sentence about an audit" />)).not.toContain('data-claims-allowed');
    const src = readFileSync('components/documents/GenerateDocumentForm.tsx', 'utf8');
    expect(src.match(/data-claims-allowed=/g)).toHaveLength(1);
    expect(src).toMatch(/data-claims-allowed="AL-1 document statement"/);
  });

  it('UX-20 M-12 M-09: Generate and Issue failures show the 7.4.2 texts and keep the typed fields; only the lost connection offers [Retry]', () => {
    const typed = { 'DC-25': 'CC BY 4.0' };
    const start: GenerateState = { phase: 'editing', typed, message: null, retry: false };
    const sent = generateReducer(start, { kind: 'send' });
    expect([sent.phase, sent.message]).toEqual(['generating', 'Generating the document...']);
    expect(generateReducer(sent, { kind: 'slow' }).message).toBe('Still generating.');
    expect(SLOW_MS).toBe(10_000);
    const cases: Array<[SendOutcome<unknown>, string]> = [
      [{ kind: 'not_saved', reason: 'network' }, 'Not generated: connection lost. Nothing was issued.'],
      [{ kind: 'rejected', status: 409, body: { error: 'x', code: 'project_archived' } }, 'Not saved: this project is archived. Owners and admins can unarchive it.'],
      [{ kind: 'rejected', status: 403, body: { error: 'x', code: 'forbidden' } }, 'Not saved: your role in this organisation no longer allows this. Your answer is kept on this device. Ask an owner or admin.'],
    ];
    for (const [outcome, text] of cases) {
      const after = generateReducer(sent, { kind: 'outcome', outcome });
      expect([after.phase, after.message, after.typed]).toEqual(['failed', text, typed]);
      const html = renderToStaticMarkup(<GenerateStatus state={after} onRetry={() => {}} />);
      expect(html).toContain(text);
      expect(/<button[^>]*type="button"[^>]*>Retry<\/button>/.test(html)).toBe(outcome.kind === 'not_saved');
    }
    const lost = generateReducer(sent, { kind: 'outcome', outcome: { kind: 'not_saved', reason: 'network' } });
    expect(lost.retry).toBe(true);
    expect(generateReducer(lost, { kind: 'retry' })).toMatchObject({ phase: 'generating', message: 'Generating the document...', typed, retry: false });
    expect(generateReducer(start, { kind: 'retry' })).toEqual(start);
  });

  it('UX-20: a refused field shows the first message the server gave for it, and an unknown refusal says nothing was issued', () => {
    const sent = generateReducer({ phase: 'editing', typed: {}, message: null, retry: false }, { kind: 'send' });
    const invalid = generateReducer(sent, { kind: 'outcome', outcome: { kind: 'rejected', status: 422, body: { error: 'Validation failed', code: 'validation', fields: [{ field: 'typedFields.DC-25', message: 'Use at most 2000 characters.' }] } } });
    expect(invalid.message).toBe('Not generated: Use at most 2000 characters.');
    const other = generateReducer(sent, { kind: 'outcome', outcome: { kind: 'rejected', status: 500, body: { error: 'x', code: 'internal_error' } } });
    expect(other.message).toBe('Not generated: something went wrong. Nothing was issued. Please try again.');
    expect(other.retry).toBe(false);
  });

  it('UX-20 (M-07, M11): a 503 document_issue_busy shows the existing server-problem text and offers Retry', () => {
    const sent = generateReducer({ phase: 'editing', typed: {}, message: null, retry: false }, { kind: 'send', to: 'issuing' });
    const busy = generateReducer(sent, { kind: 'outcome', outcome: { kind: 'rejected', status: 503, body: { error: 'x', code: 'document_issue_busy' } } });
    expect(busy.message).toBe('Not saved: the server had a problem. Your answer is kept on this device. Retry.');
    expect([busy.retry, busy.failedIn]).toEqual([true, 'issuing']);
  });

  it('UX-20 (accessibility audit): a refused typed field is marked aria-invalid, described by its message, and named in the state so the form can focus it', () => {
    const sent = generateReducer({ phase: 'editing', typed: {}, message: null, retry: false }, { kind: 'send' });
    const refused = generateReducer(sent, { kind: 'outcome', outcome: { kind: 'rejected', status: 422, body: { error: 'x', code: 'validation', fields: [
      { field: 'typedFields.DC-25', message: 'Use at most 2000 characters.' }, { field: 'sealId', message: 'Choose a seal.' }] } } });
    expect(refused.refused).toEqual([{ fieldId: 'DC-25', message: 'Use at most 2000 characters.' }]);
    expect(generateReducer(refused, { kind: 'send' }).refused).toBeUndefined();
    const doc = props().documents[0];
    const html = renderToStaticMarkup(<TypedGroup doc={doc} values={{ 'DC-25': 'x' }} set={() => {}} hidden={false} refused={new Map([['DC-25', 'Use at most 2000 characters.']])} />);
    expect(html).toMatch(/<input[^>]*id="typed-DC-25"[^>]*aria-invalid="true"[^>]*aria-describedby="typed-mark-data_card typed-error-DC-25"/);
    expect(html).toContain('<p id="typed-error-DC-25" class="field-error">Use at most 2000 characters.</p>');
    expect(renderToStaticMarkup(<TypedGroup doc={doc} values={{}} set={() => {}} hidden={false} refused={new Map()} />)).not.toContain('aria-invalid');
  });

  it('UX-20 UX-27 (7.4.2 S-18): pressing Retry after a lost Issue resends the same request id; an edited field makes a new one', async () => {
    const posted: Array<Record<string, unknown>> = [];
    const send = (async (_url: string, _method: string, body: Record<string, unknown>) => {
      posted.push(body);
      return posted.length === 1 ? { kind: 'not_saved', reason: 'network' } : { kind: 'saved', status: 201, body: {} };
    }) as unknown as typeof sendWrite;
    const body = { documentType: 'data_card' as const, sealId: 's1', typedFields: { 'DC-25': 'CC BY 4.0' } };
    const first = await submitIssue({ retry: { requestId: null, sentBody: null }, url: '/issue', body, onSlow: () => {}, send });
    expect(first.outcome).toEqual({ kind: 'not_saved', reason: 'network' });
    const again = await submitIssue({ retry: first.retry, url: '/issue', body, onSlow: () => {}, send });
    expect(again.outcome.kind).toBe('saved');
    expect(posted).toHaveLength(2);
    expect(posted[1].requestId).toBe(posted[0].requestId);
    expect(typeof posted[0].requestId).toBe('string');
    expect({ ...posted[1], requestId: null }).toEqual({ ...posted[0], requestId: null });
    await submitIssue({ retry: again.retry, url: '/issue', body: { ...body, typedFields: { 'DC-25': 'CC BY-SA 4.0' } }, onSlow: () => {}, send });
    expect(posted[2].requestId).not.toBe(posted[0].requestId);
  });

  it('UX-20 (owner question B3): an older seal chosen shows W-9\'s line, never the verification sentence', () => {
    expect(olderSealLine(1, 2)).toBe('Seal 2 is newer. This document will list seal 1 as its source.');
    expect(olderSealLine(2, 2)).toBeNull();
    const html = renderToStaticMarkup(<GenerateDocumentForm {...props({ seals: [seal(1), seal(2, { latest: true })] })} />);
    expect(html).not.toContain('Anyone who checks this document');
  });

  it('FR-DOC-05 UX-20 (7.4.2 S-18): a review never sealed shows the line and the link to seal it, and no form', () => {
    expect(NEVER_SEALED_LINE).toBe('This review has not been sealed yet. Documents come from a seal.');
    const html = renderToStaticMarkup(<NeverSealed orgSlug="o" projectId="p" reviewId="r" />);
    expect(html).toContain(NEVER_SEALED_LINE);
    expect(html).toMatch(/<a[^>]*href="\/orgs\/o\/projects\/p\/reviews\/r\/seal"[^>]*>Seal this review<\/a>/);
  });

  it('NFR-INT-05 UX-20: a seal whose check failed reads Seal check failed and cannot be chosen', () => {
    const html = renderToStaticMarkup(<GenerateDocumentForm {...props({ seals: [seal(1, { bytesMatch: false }), seal(2, { latest: true })] })} />);
    expect(html).toMatch(/<option[^>]*disabled[^>]*>[^<]*Seal 1[^<]*Seal check failed[^<]*<\/option>/);
  });

  it('M-35: after issue the form says Issued with the short SHA-256', () => {
    expect(issuedMessage({ sha256: SHA, byteSize: 84000 })).toBe(`Issued. SHA-256 ${formatFingerprint(SHA, 'short')}.`);
  });
});

describe('S-18 issued list and the S-16 slot', () => {
  it('FR-DOC-04 UX-20 M-35: the issued list shows SHA-256 in groups of four, the download size, and "A later seal exists" for an older seal', () => {
    const html = renderToStaticMarkup(<IssuedDocumentsList orgSlug="o" documents={[doc({ sealNumber: 1, byteSize: 84000 })]} latestSealNumber={2} canWithdraw />);
    expect(html).toContain(formatFingerprint(SHA, 'short'));
    expect(html).toContain('Download PDF (84 KB)');
    expect(html).toContain('A later seal exists');
    expect(html).toContain('href="/api/v1/orgs/o/documents/doc-12345678/pdf"');
    expect(renderToStaticMarkup(<IssuedDocumentsList orgSlug="o" documents={[doc({ sealNumber: 2 })]} latestSealNumber={2} canWithdraw />)).not.toContain('A later seal exists');
  });

  it('FR-DOC-04 (7.4.2 S-18): an empty issued list says No documents issued from this review yet.', () => {
    expect(NO_DOCUMENTS_LINE).toBe('No documents issued from this review yet.');
    expect(renderToStaticMarkup(<IssuedDocumentsList orgSlug="o" documents={[]} latestSealNumber={1} canWithdraw />)).toContain(NO_DOCUMENTS_LINE);
  });

  it('FR-DOC-06 FR-REV-08 (view): a withdrawn document says so with its reason, and an erased one has no download link', () => {
    const withdrawn = { ...doc(), withdrawn: { on: '2026-11-04', reason: 'Sent to the wrong committee.' } };
    expect(renderToStaticMarkup(<IssuedDocumentsList orgSlug="o" documents={[withdrawn]} latestSealNumber={1} canWithdraw />)).toContain('Withdrawn on 4 Nov 2026: Sent to the wrong committee.');
    const erased = renderToStaticMarkup(<IssuedDocumentsList orgSlug="o" documents={[{ ...doc(), erased: { erasedOn: '2026-11-04' } }]} latestSealNumber={1} canWithdraw />);
    expect(erased).toContain('Erased on 4 Nov 2026');
    expect(erased).not.toContain('Download PDF');
  });

  it('NFR-SEC-11: team text in a withdrawal reason is shown as text', () => {
    const hostile = { ...doc(), withdrawn: { on: '2026-11-04', reason: HOSTILE_STRINGS[0] } };
    const html = renderToStaticMarkup(<IssuedDocumentsList orgSlug="o" documents={[hostile]} latestSealNumber={1} canWithdraw />);
    expect(html).not.toContain('<script>');
  });

  it('FR-DOC-01 (S-16 slot): the review lists each document with its seal, date and short SHA-256, and adds no link of its own', () => {
    const withdrawn = { ...doc(), id: 'doc-87654321', documentType: 'model_card' as const, withdrawn: { on: '2026-11-04', reason: 'x' } };
    const html = renderToStaticMarkup(<ReviewDocumentsList orgSlug="o" projectId="p" reviewId="r" documents={[doc(), withdrawn]} />);
    expect(html).toContain(`Data card . from seal 1 . issued 3 Nov 2026 . SHA-256 ${formatFingerprint(SHA, 'short')}`);
    expect(html).toContain(`Model card . from seal 1 . issued 3 Nov 2026 . SHA-256 ${formatFingerprint(SHA, 'short')}`);
    expect(html).toMatch(/Withdrawn/);
    expect(html).toMatch(/Issued/);
    expect(html).not.toContain('Generate a document');   // S-16's own link is the only one (a second would repeat it)
    const empty = renderToStaticMarkup(<ReviewDocumentsList orgSlug="o" projectId="p" reviewId="r" documents={[]} />);
    expect(empty).toBe('');
  });
});
