import type { SendOutcome } from '@/lib/client/retrySafeWrite';

/**
 * The state of S-18's generate form (FR-DOC-08, UX-20): a pure reducer and the failure lines of 7.4.2, kept out of the component so
 * the words and the phase names are plain code, tested without React. Client-safe: it imports types only.
 */

export const MSG_GENERATING = 'Generating the document...';
export const MSG_STILL = 'Still generating.';
export const MSG_LOST = 'Not generated: connection lost. Nothing was issued.';
export const MSG_ARCHIVED = 'Not saved: this project is archived. Owners and admins can unarchive it.';
export const MSG_ROLE = 'Not saved: your role in this organisation no longer allows this. Your answer is kept on this device. Ask an owner or admin.';
export const MSG_SIGNED_OUT = 'Not generated: you are signed out. Sign in again, then come back. Nothing was issued.';
/** M-07 (SRS 7.5.7), the existing text, for a 503 `document_issue_busy`. */
export const MSG_SERVER = 'Not saved: the server had a problem. Your answer is kept on this device. Retry.';
export const MSG_OTHER = 'Not generated: something went wrong. Nothing was issued. Please try again.';

export type GenerateState = {
  phase: 'editing' | 'generating' | 'slow' | 'preview' | 'issuing' | 'issued' | 'failed';
  typed: Record<string, string>; message: string | null;
  /** True only after a `not_saved` outcome, the one S-18 failure that offers [Retry] (SRS line 2386). */
  retry: boolean;
  /** The phase the failure happened in, so Retry goes back to it. */
  failedIn?: 'generating' | 'issuing';
  /** The typed fields the server refused, with its message for each (422 on `typedFields.<id>`); S-18 marks and focuses them. */
  refused?: Array<{ fieldId: string; message: string }>;
};
export type GenerateEvent =
  | { kind: 'send'; typed?: Record<string, string>; to?: 'generating' | 'issuing' } | { kind: 'slow' } | { kind: 'retry' } | { kind: 'back' }
  | { kind: 'outcome'; outcome: SendOutcome<unknown> };

function refusalMessage(outcome: Exclude<SendOutcome<unknown>, { kind: 'saved' }>): string {
  if (outcome.kind === 'not_saved') return MSG_LOST;
  const { status, body } = outcome;
  if (status === 409 && body.code === 'project_archived') return MSG_ARCHIVED;
  if (status === 403 && body.code === 'forbidden') return MSG_ROLE;
  if (status === 401) return MSG_SIGNED_OUT;
  if (status === 503 && body.code === 'document_issue_busy') return MSG_SERVER;
  if (status === 422 && body.fields !== undefined && body.fields.length > 0) return `Not generated: ${body.fields[0].message}`;
  if (status === 429) {
    const minutes = Math.max(1, Math.ceil((body.retryAfterSeconds ?? 60) / 60));
    return `Not generated: too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  }
  return MSG_OTHER;
}

const TYPED_PREFIX = 'typedFields.';

export function generateReducer(s: GenerateState, e: GenerateEvent): GenerateState {
  switch (e.kind) {
    case 'send': {
      const phase = e.to === 'issuing' ? 'issuing' : 'generating';
      return { phase, typed: e.typed ?? s.typed, message: MSG_GENERATING, retry: false };
    }
    case 'slow': return s.phase === 'generating' || s.phase === 'issuing' ? { ...s, phase: 'slow', message: MSG_STILL, failedIn: s.phase } : s;
    case 'back': return { phase: 'editing', typed: s.typed, message: null, retry: false };
    case 'retry':
      return s.retry && s.failedIn !== undefined ? { phase: s.failedIn, typed: s.typed, message: MSG_GENERATING, retry: false } : s;
    case 'outcome': {
      const inPhase = s.phase === 'slow' ? (s.failedIn ?? 'generating') : s.phase === 'issuing' ? 'issuing' : 'generating';
      if (e.outcome.kind === 'saved') return { phase: inPhase === 'issuing' ? 'issued' : 'preview', typed: s.typed, message: null, retry: false };
      const refused = e.outcome.kind === 'rejected' && e.outcome.status === 422
        ? (e.outcome.body.fields ?? []).filter((f) => f.field.startsWith(TYPED_PREFIX)).map((f) => ({ fieldId: f.field.slice(TYPED_PREFIX.length), message: f.message }))
        : [];
      return { phase: 'failed', typed: s.typed, message: refusalMessage(e.outcome), ...(refused.length > 0 ? { refused } : {}), retry: e.outcome.kind === 'not_saved' || (e.outcome.status === 503 && e.outcome.body.code === 'document_issue_busy'), failedIn: inPhase };
    }
  }
}


/** True once a request has failed and the state holds its line. */
export const isFailed = (s: GenerateState): boolean => s.phase === 'failed';
