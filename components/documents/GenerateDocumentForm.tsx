'use client';

import { useEffect, useReducer, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { DOCUMENT_TYPES, type DocumentType, type Stage } from '@/types/record';
import type { DocumentPreview, IssuedDocumentView, PreviewDocumentRequest } from '@/types/api';
import type { SealRef } from '@/types/seal';
import type { UtcInstant } from '@/types/record';
import { requestIdFor, sendWrite, type RetryState, type SendOutcome } from '@/lib/client/retrySafeWrite';
import { useRouter } from 'next/navigation';
import { generateReducer, isFailed, typedToSend, type GenerateState } from '@/lib/documents/generate';
import { ETHICS_APPROVED, ETHICS_NOT_REQUIRED, ETHICS_STATES, NOT_RECORDED, SEAL_CHECK_FAILED, NOT_RECORDED_AT_ISSUE, STATEMENT, TYPED_MARK, formatUtcDay } from '@/lib/documents/copy';
import { formatFingerprint } from '@/lib/seal/format';
import { formatSize } from '@/lib/format/size';

/**
 * S-18's generate form (W-9; FR-DOC-01, FR-DOC-03, FR-DOC-05, FR-DOC-08; UX-20, UX-27, M-35). One radio group of the three documents in
 * their fixed order, each with its help line; the seal to generate from; the document-only fields the record cannot hold, each marked
 * (the mark and the "leave empty" line are read as part of every field's description); then "Generate", which shows the full
 * text before anything is stored, and "Issue this document" or "Back to edit". Nothing is kept in browser storage: the typed values
 * live in the page until the document is issued, and then in the project's draft on the server. Focus moves to the preview heading,
 * back to the Generate button, and to the "Issued" status (UX-42). Team text is only ever rendered as React text.
 */

export const NEVER_SEALED_LINE = 'This review has not been sealed yet. Documents come from a seal.';
export const NO_DOCUMENTS_LINE = 'No documents issued from this review yet.';
export { generateReducer, type GenerateEvent, type GenerateState } from '@/lib/documents/generate';

/** The failure line in an assertive region, and [Retry] only after a lost connection. */
export function GenerateStatus({ state, onRetry }: { state: GenerateState; onRetry: () => void }): ReactElement | null {
  if (!isFailed(state) || state.message === null) return null;
  return (
    <p role="alert">
      {state.message}
      {state.retry ? <> <button type="button" className="btn btn--secondary" onClick={onRetry}>Retry</button></> : null}
    </p>
  );
}

/**
 * Posts the issue with the request id `requestIdFor` gives: the same id when the body is unchanged since the last send (Retry
 * after a lost reply, UX-27) and a new one once a field was edited. The caller keeps the returned `retry` for the next press.
 */
export async function submitIssue(a: {
  retry: RetryState; url: string; body: PreviewDocumentRequest; onSlow: () => void; send?: typeof sendWrite;
}): Promise<{ outcome: SendOutcome<IssuedDocumentView>; retry: RetryState }> {
  const { requestId, state } = requestIdFor(a.retry, a.body as unknown as Record<string, unknown>);
  const outcome = await (a.send ?? sendWrite)<IssuedDocumentView>(a.url, 'POST', { ...a.body, requestId }, { onSlow: a.onSlow });
  return { outcome, retry: state };
}

/** W-9 note 1 (owner question B3): choosing an older seal says which one the document will list. */
export function olderSealLine(chosen: number, latest: number): string | null {
  return chosen < latest ? `Seal ${latest} is newer. This document will list seal ${chosen} as its source.` : null;
}

/** M-35's status text; the download link follows it. */
export function issuedMessage(d: { sha256: string; byteSize: number }): string {
  return `Issued. SHA-256 ${formatFingerprint(d.sha256, 'short')}.`;
}

/** The review has no seal: only this line and the way to make one. */
export function NeverSealed({ orgSlug, projectId, reviewId }: { orgSlug: string; projectId: string; reviewId: string }): ReactElement {
  return (
    <div>
      <p>{NEVER_SEALED_LINE}</p>
      <p><a href={`/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(reviewId)}/seal`}>Seal this review</a></p>
    </div>
  );
}

/**
 * The preview's text, line by line, as text. The one line equal to the SRS statement (7.5.3 AL-1) is the only line marked as an
 * allowed sentence; the attribute is a literal because the release check reads its text. Team text is never exempt.
 */
export function PreviewPane({ text }: { text: string }): ReactElement {
  return (
    <div className="document-preview" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {text.split('\n').map((line, i) => (
        line === STATEMENT
          ? <p key={i} style={{ margin: 0 }}><span data-claims-allowed="AL-1 document statement">{line}</span></p>
          : <p key={i} style={{ margin: 0 }}>{line === '' ? ' ' : line}</p>
      ))}
    </div>
  );
}

export type GenerateFormSeal = SealRef & { sealedAt: UtcInstant; latest: boolean; bytesMatch: boolean };
export type GenerateFormDocument = {
  type: DocumentType; title: string; help: string; neverSealedStages: Stage[];
  typedFields: Array<{ fieldId: string; label: string; structured?: 'ethics_approval' }>;
  draft: Record<string, string>;
  /** Null while the document has no generator yet (the mitigation plan before DOC-b). */
  fromRecord: { fields: number; questions: number; notRecorded: number } | null;
};
export type GenerateDocumentFormProps = { orgSlug: string; projectId: string; reviewId: string; seals: GenerateFormSeal[]; documents: GenerateFormDocument[] };

export function TypedGroup({ doc, values, set, hidden, refused }: { doc: GenerateFormDocument; values: Record<string, string>; set: (id: string, v: string) => void; hidden: boolean; refused: Map<string, string> }): ReactElement {
  const markId = `typed-mark-${doc.type}`;
  const input = (id: string, label: string) => (
    <div className="form-field" key={id}>
      <label htmlFor={`typed-${id}`}>{label}</label>
      <input id={`typed-${id}`} type="text" value={values[id] ?? ''} onChange={(e) => set(id, e.target.value)} autoComplete="off"
        aria-invalid={refused.has(id) ? true : undefined} aria-describedby={refused.has(id) ? `${markId} typed-error-${id}` : markId} />
      {refused.has(id) ? <p id={`typed-error-${id}`} className="field-error">{refused.get(id)}</p> : null}
    </div>
  );
  return (
    <div hidden={hidden} role="group" aria-labelledby={`typed-heading-${doc.type}`}>
      <h3 id={`typed-heading-${doc.type}`}>{`${doc.title}: fields the record cannot hold`}</h3>
      <p id={markId}>{`${TYPED_MARK}. Kept as a draft for next time. Leave empty to print "${NOT_RECORDED}".`}</p>
      {doc.typedFields.map((f) => {
        if (f.structured !== 'ethics_approval') return input(f.fieldId, f.label);
        const state = values[`${f.fieldId}:state`] ?? '';
        return (
          <div key={f.fieldId}>
            <div className="form-field">
              <label htmlFor={`typed-${f.fieldId}:state`}>{f.label}</label>
              <select id={`typed-${f.fieldId}:state`} value={state} onChange={(e) => set(`${f.fieldId}:state`, e.target.value)}
                aria-invalid={refused.has(`${f.fieldId}:state`) ? true : undefined} aria-describedby={refused.has(`${f.fieldId}:state`) ? `${markId} typed-error-${f.fieldId}:state` : markId}>
                <option value="">{`Print "${NOT_RECORDED}"`}</option>
                {ETHICS_STATES.map(([v, word]) => <option key={v} value={v}>{word}</option>)}
              </select>
              {refused.has(`${f.fieldId}:state`) ? <p id={`typed-error-${f.fieldId}:state`} className="field-error">{refused.get(`${f.fieldId}:state`)}</p> : null}
            </div>
            {state === ETHICS_APPROVED ? <>{input(`${f.fieldId}:committee`, 'Committee')}{input(`${f.fieldId}:reference`, 'Reference')}{input(`${f.fieldId}:date`, 'Date of approval')}</> : null}
            {state === ETHICS_NOT_REQUIRED ? <>{input(`${f.fieldId}:why`, 'Why approval is not required')}{input(`${f.fieldId}:decidedBy`, 'Who decided it is not required')}</> : null}
          </div>
        );
      })}
    </div>
  );
}

export function GenerateDocumentForm(props: GenerateDocumentFormProps): ReactElement {
  const router = useRouter();
  const base = `/api/v1/orgs/${encodeURIComponent(props.orgSlug)}/projects/${encodeURIComponent(props.projectId)}/reviews/${encodeURIComponent(props.reviewId)}/documents`;
  const latest = props.seals.find((s) => s.latest) ?? props.seals[0];
  const firstUsable = props.seals.find((s) => s.latest && s.bytesMatch) ?? props.seals.find((s) => s.bytesMatch);
  const [selected, setSelected] = useState<DocumentType>(props.documents[0]?.type ?? DOCUMENT_TYPES[0]);
  const [sealId, setSealId] = useState<string>((firstUsable ?? latest)?.sealId ?? '');
  const [values, setValues] = useState<Record<DocumentType, Record<string, string>>>(() => ({
    data_card: {}, model_card: {}, mitigation_plan: {}, ...Object.fromEntries(props.documents.map((d) => [d.type, { ...d.draft }])),
  }));
  const [state, dispatch] = useReducer(generateReducer, { phase: 'editing', typed: {}, message: null, retry: false } as GenerateState);
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [issued, setIssued] = useState<IssuedDocumentView | null>(null);
  const retry = useRef<RetryState>({ requestId: null, sentBody: null });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const generateRef = useRef<HTMLButtonElement>(null);
  const issuedRef = useRef<HTMLParagraphElement>(null);
  const doc = props.documents.find((d) => d.type === selected) as GenerateFormDocument;
  const chosen = props.seals.find((s) => s.sealId === sealId);

  useEffect(() => { if (state.phase === 'preview') headingRef.current?.focus(); }, [state.phase]);
  useEffect(() => { if (state.phase === 'issued') issuedRef.current?.focus(); }, [state.phase]);
  // A refused typed field takes focus: the first one, in the form's order (UX-42).
  useEffect(() => {
    if (state.phase !== 'failed' || state.refused === undefined) return;
    const first = props.documents.find((d) => d.type === selected)?.typedFields.flatMap((f) => (f.structured === 'ethics_approval' ? [f.fieldId, `${f.fieldId}:state`, ...['committee', 'reference', 'date', 'why', 'decidedBy'].map((x) => `${f.fieldId}:${x}`)] : [f.fieldId]))
      .find((id) => state.refused?.some((r) => r.fieldId === id));
    if (first !== undefined) document.getElementById(`typed-${first}`)?.focus();
  }, [state.phase, state.refused, props.documents, selected]);

  const body = (): PreviewDocumentRequest => ({
    documentType: selected, sealId,
    typedFields: typedToSend(values[selected]),
  });
  const busy = state.phase === 'generating' || state.phase === 'issuing' || state.phase === 'slow';
  const onSlow = () => dispatch({ kind: 'slow' });

  async function generate(): Promise<void> {
    if (busy || chosen === undefined || !chosen.bytesMatch) return;
    dispatch({ kind: 'send', typed: values[selected] });
    const out = await sendWrite<DocumentPreview>(`${base}/preview`, 'POST', { ...body() }, { onSlow });
    const ok = out.kind === 'saved' && typeof (out.body as DocumentPreview | undefined)?.text === 'string';
    // A 2xx that is not a preview says nothing sure about what the server did; for a preview nothing was stored, so the person may try again.
    dispatch({ kind: 'outcome', outcome: out.kind === 'saved' && !ok ? { kind: 'not_saved', reason: 'network' } : out });
    if (out.kind === 'saved' && ok) setPreview(out.body);
  }

  async function issue(): Promise<void> {
    if (busy) return;
    dispatch({ kind: 'send', typed: values[selected], to: 'issuing' });
    const sent = await submitIssue({ retry: retry.current, url: base, body: body(), onSlow });
    retry.current = sent.retry;
    const out = sent.outcome;
    const ok = out.kind === 'saved' && typeof (out.body as IssuedDocumentView | undefined)?.sha256 === 'string';
    // A 2xx that is not a document keeps the same request id, so Retry returns whatever was written.
    dispatch({ kind: 'outcome', outcome: out.kind === 'saved' && !ok ? { kind: 'not_saved', reason: 'network' } : out });
    if (out.kind === 'saved' && ok) {
      setIssued(out.body);
      retry.current = { requestId: null, sentBody: null };
      router.refresh();   // the issued list below is the server's: it reads the new document
    }
  }

  function backToEdit(): void {
    dispatch({ kind: 'back' });
    setPreview(null);
    requestAnimationFrame(() => generateRef.current?.focus());
  }

  function onRetry(): void {
    dispatch({ kind: 'retry' });
    if (state.failedIn === 'issuing') void issue(); else void generate();
  }

  const older = chosen === undefined || latest === undefined ? null : olderSealLine(chosen.sealNumber, latest.sealNumber);
  // Once a preview exists the person stays on it, through an Issue that is slow or fails, until they go back to edit.
  const inPreview = preview !== null && state.phase !== 'editing';

  if (issued !== null && state.phase === 'issued') {
    return (
      <div>
        <p role="status" tabIndex={-1} ref={issuedRef}>{issuedMessage(issued)}</p>
        <p><a href={`/api/v1/orgs/${encodeURIComponent(props.orgSlug)}/documents/${encodeURIComponent(issued.id)}/pdf`}>{`Download PDF (${formatSize(issued.byteSize)})`}</a></p>
        <p><a href={`/orgs/${encodeURIComponent(props.orgSlug)}/projects/${encodeURIComponent(props.projectId)}/reviews/${encodeURIComponent(props.reviewId)}/documents`}>Generate another document</a></p>
      </div>
    );
  }

  if (inPreview && preview !== null) {
    return (
      <div>
        <h2 tabIndex={-1} ref={headingRef}>{`Preview: ${doc.title} (not issued yet; nothing is stored until you press Issue)`}</h2>
        <PreviewPane text={preview.text} />
        {preview.notRecordedFields.length > 0 ? <p>{`${preview.notRecordedFields.length} ${preview.notRecordedFields.length === 1 ? 'field reads' : 'fields read'} "${NOT_RECORDED}" or "${NOT_RECORDED_AT_ISSUE}".`}</p> : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'center' }}>
          <button type="button" className="btn btn--primary" aria-disabled={busy || undefined} onClick={() => { void issue(); }}>Issue this document</button>
          <button type="button" className="btn btn--secondary" aria-disabled={busy || undefined} onClick={() => { if (!busy) backToEdit(); }}>Back to edit</button>
        </div>
        <p role="status">{busy ? state.message : ''}</p>
        <GenerateStatus state={state} onRetry={onRetry} />
      </div>
    );
  }

  return (
    <form method="post" onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); void generate(); }} noValidate>
      <fieldset>
        <legend>Documents</legend>
        {props.documents.map((d) => (
          <div key={d.type} className="form-field">
            <input type="radio" name="document-type" id={`doc-${d.type}`} value={d.type} checked={selected === d.type} onChange={() => setSelected(d.type)} aria-describedby={`help-${d.type}`} />
            <label htmlFor={`doc-${d.type}`}>{d.title}</label>
            <p id={`help-${d.type}`}>{d.help}</p>
            {d.neverSealedStages.length > 0 ? (
              <p>{`Part of this document comes from the ${d.neverSealedStages.join(' and ')} stage, which has not been sealed. Those fields will read "${NOT_RECORDED_AT_ISSUE}".`}</p>
            ) : null}
          </div>
        ))}
      </fieldset>

      <div className="form-field">
        <label htmlFor="document-seal">Seal to generate from</label>
        <select id="document-seal" value={sealId} onChange={(e) => setSealId(e.target.value)} aria-describedby={older === null ? undefined : 'document-seal-note'}>
          {props.seals.map((s) => (
            <option key={s.sealId} value={s.sealId} disabled={!s.bytesMatch}>
              {`Seal ${s.sealNumber}, ${formatUtcDay(s.sealedAt)}${s.latest ? ' (latest)' : ''}${s.bytesMatch ? '' : `. ${SEAL_CHECK_FAILED}`}`}
            </option>
          ))}
        </select>
        {older === null ? null : <p id="document-seal-note">{older}</p>}
      </div>

      {props.documents.map((d) => (
        <TypedGroup key={d.type} doc={d} hidden={selected !== d.type} values={values[d.type]}
          refused={new Map(selected === d.type && state.phase === 'failed' ? (state.refused ?? []).map((r) => [r.fieldId, r.message]) : [])}
          set={(id, v) => setValues((all) => ({ ...all, [d.type]: { ...all[d.type], [id]: v } }))} />
      ))}

      {doc.fromRecord === null ? null : (
        <p>{fromRecordLine(doc.fromRecord)}</p>
      )}
      <button type="submit" ref={generateRef} className="btn btn--primary" aria-disabled={busy || chosen === undefined || !chosen.bytesMatch || undefined}>Generate document</button>
      <p role="status">{busy ? state.message : ''}</p>
      <GenerateStatus state={state} onRetry={onRetry} />
    </form>
  );
}

/**
 * The summary line under the form: how many fields, how many questions they come from, and how many will read "Not recorded". A document
 * whose fields take no question (the mitigation plan reads findings and mitigations) says "<n> fields" and leaves the questions out.
 */
export function fromRecordLine(r: { fields: number; questions: number; notRecorded: number }): string {
  const from = r.questions === 0 ? `${r.fields} fields` : `${r.fields} fields from ${r.questions} questions`;
  return `${from} . ${r.notRecorded} fields will read "${NOT_RECORDED}"`;
}
