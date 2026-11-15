'use client';

import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { OPEN_LOST, isReviewBody, openRefusal } from './reviewText';
import { clearRetry, loadRetry, openRetryKey, retryAfter, saveRetry, sessionRetryStorage } from './retryStore';
import { stageReviewName } from '@/lib/seal/reviewName';
import { markTerms } from './markTerms';
import { Definition } from '@/components/ui/Definition';
import { STAGES, type Stage } from '@/types/record';
import type { ApiErrorBody, StageReviewView } from '@/types/api';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { FieldError, FieldLabel } from '@/components/ui/TextInput';
import { StatusRegion } from '@/components/ui/StatusRegion';
import '@/components/ui/selectStyles';
import '@/components/ui/textAreaStyles';
import { REVIEW_COPY } from '@/lib/review/copy';
import { STAGE_TERMS } from '@/lib/vocabulary/maps';
// The form's layout (.review-form): the open page loads no other file that imports it, so a direct visit had none (FX4).
import './review.css';

const MAX = 120;
const C = REVIEW_COPY.open;

/** Code points of the NFC form: the server's count (lib/data/reviews.ts), not the browser's UTF-16 `maxlength`. */
const noteLength = (s: string) => [...s.normalize('NFC').trim()].length;

export type OpenReviewFormProps = {
  orgSlug: string; projectId: string;
  /** The signed-in account: the stored request id is this account's only (C4 round 3, F1). */
  userId: string;
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
  // The request id survives a reload in this tab, so opening again after a lost reply replays it (hunter H1 ruling).
  const retry = useRef<RetryState | null>(null);
  const retryKey = openRetryKey(props.userId, props.projectId);
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
    setStatus(C.sending);
    const body = { stage, preparedFor: note.trim() === '' ? null : note };
    const { requestId, state } = requestIdFor(retry.current ?? loadRetry(sessionRetryStorage(), retryKey), body);
    retry.current = state;
    saveRetry(sessionRetryStorage(), retryKey, state);
    const out = await sendWrite<StageReviewView>(url, 'POST', { ...body, requestId }, { onSlow: () => setStatus(C.slow) });
    setStatus('');
    const ok = out.kind === 'saved' && isReviewBody(out.body);
    if (retryAfter(out.kind === 'rejected' ? { kind: 'rejected', status: out.status, code: out.body.code } : out.kind === 'saved' ? { kind: 'saved', bodyOk: ok } : { kind: 'not_saved' }) === 'clear') {
      retry.current = { requestId: null, sentBody: null };
      clearRetry(sessionRetryStorage(), retryKey);
    }
    if (out.kind === 'saved' && isReviewBody(out.body)) {
      // Still busy while the next page loads, so the button cannot open a second review (S-17 hunt H4).
      router.push(`/orgs/${encodeURIComponent(props.orgSlug)}/projects/${encodeURIComponent(props.projectId)}/reviews/${encodeURIComponent(out.body.id)}`);
      return;
    }
    setBusy(false);
    // A 2xx that is not a review says nothing sure: the same id is kept, so pressing again replays what was written.
    if (out.kind === 'saved' || out.kind === 'not_saved') {
      setAlert(OPEN_LOST);
      return;
    }
    const b: ApiErrorBody = out.body;
    const f = b.fields?.find((x) => x.field === 'preparedFor' || x.field === 'stage');
    if (out.status === 422 && f !== undefined && f.field === 'stage' && props.fixedStage !== null) {
      setAlert(f.message);   // the stage is fixed, so there is no select to mark (S-17 hunt H7)
    } else if (out.status === 422 && f !== undefined) {
      setFieldError({ field: f.field as 'preparedFor' | 'stage', message: f.message });
      (f.field === 'stage' ? stageRef : noteRef).current?.focus();
    } else {
      const refusal = openRefusal(out);
      setAlert(refusal.message);
      if (refusal.refresh) {
        // Another review of this stage took the number: a new request id, and the page reloads with the next name.
        router.refresh();
      }
    }
  }

  const noteDescribedBy = ['open-review-help', 'open-review-count', fieldError?.field === 'preparedFor' ? 'open-review-note-error' : null].filter(Boolean).join(' ');
  const stageInvalid = fieldError?.field === 'stage';
  const noteInvalid = fieldError?.field === 'preparedFor' || count > MAX;
  return (
    <form method="post" onSubmit={(e) => { void submit(e); }} noValidate className="review-form">
      {/* The name holds the page's first use of the stage's name: its meaning follows it, and changes with the stage (D1). */}
      <p>{C.nameLabel} <strong>{markTerms(stageReviewName(stage, props.nextNumbers[stage]), [STAGE_TERMS[stage]])}</strong></p>
      <Definition of={STAGE_TERMS[stage]} as="p" />
      {props.fixedStage === null ? (
        <div className="ui-field">
          <FieldLabel htmlFor="open-review-stage" label={C.stageLabel} />
          <div className="ui-select__wrap">
            <select
              id="open-review-stage" ref={stageRef} value={stage} onChange={(e) => { if (!busy) setStage(e.target.value as Stage); }} aria-disabled={busy || undefined}
              aria-invalid={stageInvalid || undefined} aria-describedby={stageInvalid ? 'open-review-stage-error' : undefined}
              className={stageInvalid ? 'ui-select ui-select--invalid' : 'ui-select'}
            >
              {STAGES.map((s) => <option key={s} value={s}>{REVIEW_COPY.stageNames[s]}</option>)}
            </select>
            <span className="ui-select__icon"><Icon name="chevron-down" size={20} /></span>
          </div>
          {fieldError?.field === 'stage' ? <FieldError id="open-review-stage-error" message={fieldError.message} /> : null}
        </div>
      ) : (
        <p>{C.fixedStage(REVIEW_COPY.stageNames[props.fixedStage])}</p>
      )}
      <div className="ui-field">
        <FieldLabel htmlFor="open-review-note" label={C.noteLabel} />
        <input
          id="open-review-note" ref={noteRef} type="text" value={note} readOnly={busy} onChange={(e) => setNote(e.target.value)}
          aria-describedby={noteDescribedBy} aria-invalid={noteInvalid || undefined}
          autoComplete="off"
          className={['ui-input', noteInvalid && 'ui-input--invalid', busy && 'ui-input--readonly'].filter(Boolean).join(' ')}
        />
        <p id="open-review-help" className="ui-field__hint">{C.help}</p>
        <p id="open-review-count" className={count > MAX ? 'ui-count ui-count--over' : 'ui-count'}>{C.count(count, MAX)}</p>
        {fieldError?.field === 'preparedFor' ? <FieldError id="open-review-note-error" message={fieldError.message} /> : null}
      </div>
      <Button type="submit" variant="primary" busy={busy}>{C.submit}</Button>
      <StatusRegion message={status} />
      <StatusRegion message={alert} politeness="assertive" tone="error" />
    </form>
  );
}
