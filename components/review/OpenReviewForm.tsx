'use client';

import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { openRefusal } from './reviewText';
import { stageReviewName } from '@/lib/seal/reviewName';
import { STAGES, type Stage } from '@/types/record';
import type { ApiErrorBody, StageReviewView } from '@/types/api';

/** FR-REV-01's help text under the note (SRS line 2100), verbatim. */
const HELP = 'What is this review for? For example: UNCST protocol submission; data transfer agreement with the partner hospital; annual renewal; NeurIPS datasets track; Hugging Face upload. Use roles, not names.';
const MAX = 120;
const STAGE_WORDS: Record<Stage, string> = { 'pre-processing': 'Pre-processing', 'in-processing': 'In-processing', 'post-processing': 'Post-processing' };

/** Code points of the NFC form: the server's count (lib/data/reviews.ts), not the browser's UTF-16 `maxlength`. */
const noteLength = (s: string) => [...s.normalize('NFC').trim()].length;

export type OpenReviewFormProps = {
  orgSlug: string; projectId: string;
  /** The stage the form was opened for (`?stage=`), or null for a select. */
  fixedStage: Stage | null;
  /** The number the next review of each stage takes, for the generated name shown above the field. */
  nextNumbers: Record<Stage, number>;
};

/**
 * The "Open a stage review" form (W-7 open form, FR-REV-01): the generated name shown as text and not editable, the
 * stage fixed or a native select, and the optional note as a native input whose help text and live count are named
 * by `aria-describedby`. There is no `maxlength`, since the browser counts UTF-16 units and the server counts code
 * points after NFC; an over-long note is announced by the count and refused by the server. The note travels in the
 * JSON body only, never in an address (NFR-PRIV-04). A refused field gets its message, `aria-invalid` and focus.
 */
export function OpenReviewForm(props: OpenReviewFormProps): ReactElement {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>(props.fixedStage ?? 'pre-processing');
  const [note, setNote] = useState('');
  const [fieldError, setFieldError] = useState<{ field: 'preparedFor' | 'stage'; message: string } | null>(null);
  const [status, setStatus] = useState('');
  const [alert, setAlert] = useState('');
  const [busy, setBusy] = useState(false);
  const retry = useRef<RetryState>({ requestId: null, sentBody: null });
  const noteRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLSelectElement>(null);

  const url = `/api/v1/orgs/${encodeURIComponent(props.orgSlug)}/projects/${encodeURIComponent(props.projectId)}/reviews`;
  const count = noteLength(note);

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFieldError(null);
    setAlert('');
    setStatus('Opening...');
    const body = { stage, preparedFor: note.trim() === '' ? null : note };
    const { requestId, state } = requestIdFor(retry.current, body);
    retry.current = state;
    const out = await sendWrite<StageReviewView>(url, 'POST', { ...body, requestId }, { onSlow: () => setStatus('Still opening. The connection is slow.') });
    setBusy(false);
    setStatus('');
    if (out.kind === 'saved') {
      router.push(`/orgs/${encodeURIComponent(props.orgSlug)}/projects/${encodeURIComponent(props.projectId)}/reviews/${encodeURIComponent(out.body.id)}`);
      return;
    }
    if (out.kind === 'not_saved') {
      setAlert('Not opened: connection lost. Retry is safe: it will not open the review twice.');
      return;
    }
    const b: ApiErrorBody = out.body;
    const f = b.fields?.find((x) => x.field === 'preparedFor' || x.field === 'stage');
    if (out.status === 422 && f !== undefined) {
      setFieldError({ field: f.field as 'preparedFor' | 'stage', message: f.message });
      (f.field === 'stage' ? stageRef : noteRef).current?.focus();
    } else {
      const refusal = openRefusal(out);
      setAlert(refusal.message);
      if (refusal.refresh) {
        // Another review of this stage took the number: a new request id, and the page reloads with the next name.
        retry.current = { requestId: null, sentBody: null };
        router.refresh();
      }
    }
  }

  const noteDescribedBy = ['open-review-help', 'open-review-count', fieldError?.field === 'preparedFor' ? 'open-review-note-error' : null].filter(Boolean).join(' ');
  return (
    <form onSubmit={(e) => { void submit(e); }} noValidate>
      <p>Name: <strong>{stageReviewName(stage, props.nextNumbers[stage])}</strong></p>
      {props.fixedStage === null ? (
        <div className="form-field">
          <label htmlFor="open-review-stage">Stage</label>
          <select
            id="open-review-stage" ref={stageRef} value={stage} onChange={(e) => setStage(e.target.value as Stage)}
            aria-invalid={fieldError?.field === 'stage' || undefined} aria-describedby={fieldError?.field === 'stage' ? 'open-review-stage-error' : undefined}
          >
            {STAGES.map((s) => <option key={s} value={s}>{STAGE_WORDS[s]}</option>)}
          </select>
          {fieldError?.field === 'stage' ? <p id="open-review-stage-error" className="field-error">{fieldError.message}</p> : null}
        </div>
      ) : (
        <p>Stage: {props.fixedStage}</p>
      )}
      <div className="form-field">
        <label htmlFor="open-review-note">Prepared for (optional)</label>
        <input
          id="open-review-note" ref={noteRef} type="text" value={note} onChange={(e) => setNote(e.target.value)}
          aria-describedby={noteDescribedBy} aria-invalid={fieldError?.field === 'preparedFor' || count > MAX || undefined}
          autoComplete="off"
        />
        <p id="open-review-help">{HELP}</p>
        <p id="open-review-count">{`${count} of ${MAX}`}</p>
        {fieldError?.field === 'preparedFor' ? <p id="open-review-note-error" className="field-error">{fieldError.message}</p> : null}
      </div>
      <button type="submit" className="btn btn--primary" aria-disabled={busy || undefined}>Open a stage review</button>
      <p role="status">{status}</p>
      <div role="alert">{alert}</div>
    </form>
  );
}
