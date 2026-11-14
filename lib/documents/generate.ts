import type { SendOutcome } from '@/lib/client/retrySafeWrite';
import { DOCUMENTS_COPY, ETHICS_APPROVED, ETHICS_NOT_REQUIRED, MSG_ISSUE_NO_REPLY, MSG_PREVIEW_SERVER, MSG_SEAL_CHECK_FAILED, type DocumentPhase } from './copy';
import { FINDINGS_COPY } from '@/lib/findings/copy';

/**
 * The state of S-18's generate form (FR-DOC-08, UX-20): a pure reducer and the failure lines of 7.4.2, kept out of the component so
 * the words and the phase names are plain code, tested without React. Client-safe: it imports types only.
 */

const S = DOCUMENTS_COPY.status;
const R = DOCUMENTS_COPY.refusal;
const F = DOCUMENTS_COPY.fieldMessages;

/** The status while a request is out, and the line once it is slow, for each phase. */
const sendingLine = (phase: DocumentPhase): string => (phase === 'issuing' ? S.issuing : S.making);
const slowLine = (phase: DocumentPhase): string => (phase === 'issuing' ? S.stillIssuing : S.stillMaking);

/** The server's field messages S-18 knows (lib/data/documents.ts); any other is never shown (the lead's ruling, G-c4). */
const KNOWN_FIELD_MESSAGES: ReadonlySet<string> = new Set([
  F.sealNotOfReview, F.chooseSeal, F.notTypeable, F.mustBeText, F.chooseEthics, F.notOfState, F.chooseDocument, MSG_SEAL_CHECK_FAILED,
]);
const TOO_LONG = /^Use at most \d+ characters\.$/;
export const isKnownFieldMessage = (message: string): boolean => KNOWN_FIELD_MESSAGES.has(message) || TOO_LONG.test(message);
/** A withdrawal's field messages S-18 knows: the reason's, from the findings words the route uses (lib/data/documents.ts). */
const WITHDRAW_TOO_LONG = /^This is [\d,]+ characters\. The limit is [\d,]+\.$/;
export const isKnownWithdrawMessage = (message: string): boolean =>
  message === FINDINGS_COPY.fields.eventReason || message === FINDINGS_COPY.fields.notStorable || WITHDRAW_TOO_LONG.test(message);

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
function refusalMessage(outcome: Exclude<SendOutcome<unknown>, { kind: 'saved' }>, inPhase: DocumentPhase): string {
  if (outcome.kind === 'not_saved') return inPhase === 'issuing' ? MSG_ISSUE_NO_REPLY : R.lost;
  const { status, body } = outcome;
  if (status === 409 && body.code === 'project_archived') return R.archived(inPhase);
  if (status === 403 && body.code === 'forbidden') return R.role(inPhase);
  if (status === 401) return R.signedOut(inPhase);
  if (status >= 500) return inPhase === 'issuing' ? MSG_ISSUE_NO_REPLY : MSG_PREVIEW_SERVER;
  if (status === 422 && body.fields !== undefined && body.fields.length > 0) {
    const message = body.fields[0].message;
    return isKnownFieldMessage(message) ? R.field(inPhase, message) : R.unknownField(inPhase);
  }
  if (status === 429) {
    const minutes = Math.max(1, Math.ceil((body.retryAfterSeconds ?? 60) / 60));
    return R.tooMany(inPhase, minutes);
  }
  return R.other(inPhase);
}

const TYPED_PREFIX = 'typedFields.';

export function generateReducer(s: GenerateState, e: GenerateEvent): GenerateState {
  switch (e.kind) {
    case 'send': {
      const phase = e.to === 'issuing' ? 'issuing' : 'generating';
      return { phase, typed: e.typed ?? s.typed, message: sendingLine(phase), retry: false };
    }
    case 'slow': return s.phase === 'generating' || s.phase === 'issuing' ? { ...s, phase: 'slow', message: slowLine(s.phase), failedIn: s.phase } : s;
    case 'back': return { phase: 'editing', typed: s.typed, message: null, retry: false };
    case 'retry':
      return s.retry && s.failedIn !== undefined ? { phase: s.failedIn, typed: s.typed, message: sendingLine(s.failedIn), retry: false } : s;
    case 'outcome': {
      const inPhase = s.phase === 'slow' ? (s.failedIn ?? 'generating') : s.phase === 'issuing' ? 'issuing' : 'generating';
      if (e.outcome.kind === 'saved') return { phase: inPhase === 'issuing' ? 'issued' : 'preview', typed: s.typed, message: null, retry: false };
      const refused = e.outcome.kind === 'rejected' && e.outcome.status === 422
        ? (e.outcome.body.fields ?? []).filter((f) => f.field.startsWith(TYPED_PREFIX) && isKnownFieldMessage(f.message)).map((f) => ({ fieldId: f.field.slice(TYPED_PREFIX.length), message: f.message }))
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
