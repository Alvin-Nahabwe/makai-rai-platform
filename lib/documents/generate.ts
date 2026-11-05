import type { SendOutcome } from '@/lib/client/retrySafeWrite';
import { ETHICS_APPROVED, ETHICS_NOT_REQUIRED, MSG_ISSUE_NO_REPLY, MSG_PREVIEW_SERVER, MSG_ROLE_CHANGED } from './copy';

/**
 * The state of S-18's generate form (FR-DOC-08, UX-20): a pure reducer and the failure lines of 7.4.2, kept out of the component so
 * the words and the phase names are plain code, tested without React. Client-safe: it imports types only.
 */

export const MSG_GENERATING = 'Generating the document...';
export const MSG_STILL = 'Still generating.';
export const MSG_LOST = 'Not generated: connection lost. Nothing was issued.';
export const MSG_ARCHIVED = 'Not saved: this project is archived. Owners and admins can unarchive it.';
export const MSG_SIGNED_OUT = 'Not generated: you are signed out. Sign in again, then come back. Nothing was issued.';
export const MSG_OTHER = 'Not generated: something went wrong. Nothing was issued. Please try again.';

export type GenerateState = {
  phase: 'editing' | 'generating' | 'slow' | 'preview' | 'issuing' | 'issued' | 'failed';
  typed: Record<string, string>; message: string | null;
  /** True after a failure that may not have reached the server or that the server did not answer (no reply, 5xx, 503 busy): [Retry] is safe, since Issue replays on its request id. */
  retry: boolean;
  /** The phase the failure happened in, so Retry goes back to it. */
  failedIn?: 'generating' | 'issuing';
  /** The typed fields the server refused, with its message for each (422 on `typedFields.<id>`); S-18 marks and focuses them. */
  refused?: Array<{ fieldId: string; message: string }>;
};
export type GenerateEvent =
  | { kind: 'send'; typed?: Record<string, string>; to?: 'generating' | 'issuing' } | { kind: 'slow' } | { kind: 'retry' } | { kind: 'back' }
  | { kind: 'outcome'; outcome: SendOutcome<unknown> };

/**
 * The line for a failed send. "Nothing was issued" is said only where the client knows it: a 4xx refusal, or a preview (which writes
 * nothing). After an Issue that got no reply, or a 5xx, the client cannot know: that line says the document may have been issued and
 * that Retry is safe, which holds because Issue replays on its request id (idempotentWrite).
 */
function refusalMessage(outcome: Exclude<SendOutcome<unknown>, { kind: 'saved' }>, inPhase: 'generating' | 'issuing'): string {
  if (outcome.kind === 'not_saved') return inPhase === 'issuing' ? MSG_ISSUE_NO_REPLY : MSG_LOST;
  const { status, body } = outcome;
  if (status === 409 && body.code === 'project_archived') return MSG_ARCHIVED;
  if (status === 403 && body.code === 'forbidden') return MSG_ROLE_CHANGED;
  if (status === 401) return MSG_SIGNED_OUT;
  if (status >= 500) return inPhase === 'issuing' ? MSG_ISSUE_NO_REPLY : MSG_PREVIEW_SERVER;
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
      return { phase: 'failed', typed: s.typed, message: refusalMessage(e.outcome, inPhase), ...(refused.length > 0 ? { refused } : {}), retry: e.outcome.kind === 'not_saved' || e.outcome.status >= 500, failedIn: inPhase };
    }
  }
}


/** True once a request has failed and the state holds its line. */
export const isFailed = (s: GenerateState): boolean => s.phase === 'failed';

/** The sub-fields of the ethics review (DC-15, CG-10) each state uses; the others are not sent. */
const ETHICS_SUB: Readonly<Record<string, readonly string[]>> = {
  [ETHICS_APPROVED]: ['committee', 'reference', 'date'],
  [ETHICS_NOT_REQUIRED]: ['why', 'decidedBy'],
};

/**
 * The typed values a request carries: every filled value, except a sub-field of a state the person moved away from (it is hidden in the
 * form but still held, and the server refuses a sub-field its state does not use). A restored draft is cleaned the same way.
 */
export function typedToSend(values: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(values)) {
    if (value.trim() === '') continue;
    const at = id.indexOf(':');
    if (at > 0) {
      const sub = id.slice(at + 1);
      const state = (values[`${id.slice(0, at)}:state`] ?? '').trim();
      if (sub !== 'state' && !(ETHICS_SUB[state] ?? []).includes(sub)) continue;
    }
    out[id] = value;
  }
  return out;
}
