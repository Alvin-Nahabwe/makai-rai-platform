import { problemSummary, savedMessage } from '@/lib/decision/copy';
import { DECISION_OUTCOME_COPY } from '@/lib/decision/outcome/copy';
import type { SendOutcome } from '@/lib/client/retrySafeWrite';
import type { DecisionVersionView } from '@/types/api';
import type { FieldError } from '@/types/record';

/**
 * The save status line of S-12 (7.4.1, 7.4.3, UX-25): what one outcome of `sendWrite` says, in the exact
 * messages M-01 to M-12 (SRS 7.5.7, lines 2548-2559; their words are DECISION_OUTCOME_COPY's), how it is announced (progress and success politely,
 * every failure assertively) and what the person can do next. Plain TypeScript, so the form imports it.
 */

/** M-01 to M-12 (SRS 7.5.7), and GATE: a save refused until the person accepts new terms or changes their password. */
export type SaveMessageId = 'M-01' | 'M-02' | 'M-03' | 'M-04' | 'M-05' | 'M-06' | 'M-07' | 'M-08' | 'M-09' | 'M-10' | 'M-11' | 'M-12' | 'GATE';
export interface SaveStatus {
  id: SaveMessageId; text: string; live: 'polite' | 'assertive'; next: 'none' | 'retry' | 'sign_in' | 'conflict' | 'fix' | 'go';
  /** A link beside the status line, for `next: 'go'`. */
  action?: { label: string; href: string };
}

const S = DECISION_OUTCOME_COPY.save;
const M = {
  'M-01': S.saving,
  'M-02': S.slow,
  'M-05': S.connection,
  'M-06': S.noReply,
  'M-07': S.server,
  'M-08': S.signedOut,
  'M-09': S.forbidden,
  'M-12': S.archived,
} as const;

const failure = (id: keyof typeof M, next: SaveStatus['next']): SaveStatus => ({ id: id as SaveMessageId, text: M[id], live: 'assertive', next });

/** M-01 while the request is out; M-02 once `SLOW_MS` passed with no reply. */
export function savingStatus(slow: boolean): SaveStatus {
  return slow
    ? { id: 'M-02', text: M['M-02'], live: 'polite', next: 'none' }
    : { id: 'M-01', text: M['M-01'], live: 'polite', next: 'none' };
}

/** A decision version view as route 1 answers it: the fields the status line reads. */
function isVersionView(v: unknown): v is DecisionVersionView {
  const c = v as Partial<DecisionVersionView> | null | undefined;
  return typeof c === 'object' && c !== null && typeof c.versionNumber === 'number' && typeof c.receivedAt === 'string'
    && typeof c.enteredBy === 'object' && c.enteredBy !== null && typeof c.enteredBy.userId === 'string';
}

/** The current version a 409 `base_version_moved` carries (contract "Error codes"), or null when the body has none. */
export function conflictCurrent(o: SendOutcome<DecisionVersionView>): DecisionVersionView | null {
  if (o.kind !== 'rejected' || o.status !== 409 || o.body.code !== 'base_version_moved') return null;
  return isVersionView(o.body.current) ? o.body.current : null;
}

/**
 * The message for one outcome. A 2xx is M-03 (201, a new version) or M-04 (200, the request id was seen
 * before: FR-DEC-07). A rejection is mapped by status and code; any status the table does not name, a 429
 * included (7.5.7 has no rate-limit text for decisions: owner question B1), and a conflict whose body lacks
 * the current version, is M-07, which keeps the draft and offers Retry: nothing on that path says "saved". So is a
 * 2xx whose body is not a decision version.
 */
export function statusForOutcome(o: SendOutcome<DecisionVersionView>, ctx: { viewerId: string; timeText: (iso: string) => string }): SaveStatus {
  if (o.kind === 'saved') {
    const v = o.body;
    // A 2xx that is not a version (a 204, a body of another shape) proves nothing was saved as a version: Retry
    // re-sends the same id, and the server replays the version if it had been saved (FR-DEC-07).
    if (!isVersionView(v)) return failure('M-07', 'retry');
    return o.status === 201
      ? { id: 'M-03', text: savedMessage(v, ctx.timeText(v.receivedAt), ctx.viewerId), live: 'polite', next: 'none' }
      : { id: 'M-04', text: DECISION_OUTCOME_COPY.alreadySaved(ctx.timeText(v.receivedAt), v.versionNumber), live: 'polite', next: 'none' };
  }
  if (o.kind === 'not_saved') return o.reason === 'timeout' ? failure('M-06', 'retry') : failure('M-05', 'retry');
  const { status } = o;
  const code = o.body.code;
  if (status === 401) return failure('M-08', 'sign_in');
  if (status === 403 && code === 'forbidden') return failure('M-09', 'none');
  if (status === 422) return { id: 'M-11', text: problemSummary(Math.max(1, o.body.fields?.length ?? 0)), live: 'assertive', next: 'fix' };
  if (status === 409 && code === 'project_archived') return failure('M-12', 'none');
  if (status === 409 && code === 'base_version_moved') {
    const current = conflictCurrent(o);
    if (current !== null) return { id: 'M-10', text: conflictText(current, ctx.viewerId, ctx.timeText), live: 'assertive', next: 'conflict' };
  }
  return failure('M-07', 'retry');
}

/**
 * The outcomes the contract's Error codes table answers by leaving the status line (00-contract.md, Error codes):
 * 403 `acceptances_required` goes to S-05 and 403 `must_change_password` to S-29, each with the question as its
 * `callbackUrl`; a 404 (the project or the organisation is no longer this person's) refreshes the page so its own
 * not-found renders, with no Retry. Null for every other outcome, which `statusForOutcome` shows. The caller keeps the
 * draft on this device before it navigates.
 */
export function navigationForOutcome(o: SendOutcome<DecisionVersionView>, questionPath: string): { kind: 'go'; href: string } | { kind: 'refresh' } | null {
  if (o.kind !== 'rejected') return null;
  const back = `callbackUrl=${encodeURIComponent(questionPath)}`;
  if (o.status === 403 && o.body.code === 'acceptances_required') return { kind: 'go', href: `/acceptances?${back}` };
  if (o.status === 403 && o.body.code === 'must_change_password') return { kind: 'go', href: `/change-password?${back}` };
  if (o.status === 404) return { kind: 'refresh' };
  return null;
}

/**
 * A 403 gate when this browser cannot keep the answer (ruling on CR-2): the form stays, the answer stays in its field,
 * and the line says what to do first with a link there, instead of navigating away from the only copy. It also says
 * that following the link leaves that copy behind, so the person copies the answer first. The texts are owner copy,
 * queued for the owner's review.
 */
export function gateStatus(nav: { kind: 'go'; href: string }): SaveStatus {
  const terms = nav.href.startsWith('/acceptances');
  const G = DECISION_OUTCOME_COPY.gate;
  return {
    id: 'GATE', live: 'assertive', next: 'go',
    text: terms ? G.terms : G.password,
    action: { label: terms ? G.termsLink : G.passwordLink, href: nav.href },
  };
}

/** M-10, both variants: another person, or the same account (an earlier attempt from this or another device). */
export function conflictText(current: DecisionVersionView, viewerId: string, timeText: (iso: string) => string): string {
  const at = timeText(current.receivedAt);
  return current.enteredBy.userId === viewerId
    ? DECISION_OUTCOME_COPY.conflict.own(at)
    : DECISION_OUTCOME_COPY.conflict.other(current.enteredBy.name, at);
}

/**
 * The withdrawal's lines (7.4.2 S-13 row: "Withdrawing..." then "Withdrawn. The question has no current decision.";
 * failures follow the 7.4.1 pattern). `maybeArrived` is the owner's line for every outcome where the withdrawal may have
 * been recorded (no reply, a lost reply, a 2xx that is not a version): route 2 replays a repeated request id (FR-DEC-07),
 * so Retry cannot withdraw twice. The words are DECISION_OUTCOME_COPY.withdraw's.
 */
export const WITHDRAW_TEXT = DECISION_OUTCOME_COPY.withdraw;

export type WithdrawResult = { kind: 'withdrawn' } | { kind: 'fix'; fields: FieldError[] } | { kind: 'failed'; text: string; retry: boolean };

/** What one outcome of route 2 means for the withdrawal control (FR-DEC-08). */
export function withdrawOutcome(o: SendOutcome<DecisionVersionView>): WithdrawResult {
  if (o.kind === 'saved') return isVersionView(o.body) ? { kind: 'withdrawn' } : { kind: 'failed', text: WITHDRAW_TEXT.maybeArrived, retry: true };
  if (o.kind === 'not_saved') return { kind: 'failed', text: WITHDRAW_TEXT.maybeArrived, retry: true };
  const { status, body } = o;
  if (status === 422) return { kind: 'fix', fields: body.fields !== undefined && body.fields.length > 0 ? body.fields : [{ field: 'reason', message: body.error }] };
  if (status === 401) return { kind: 'failed', text: WITHDRAW_TEXT.signedOut, retry: false };
  if (status === 403) return { kind: 'failed', text: WITHDRAW_TEXT.forbidden, retry: false };
  if (status === 409 && body.code === 'base_version_moved') return { kind: 'failed', text: WITHDRAW_TEXT.moved, retry: false };
  if (status === 409 && body.code === 'project_archived') return { kind: 'failed', text: WITHDRAW_TEXT.archived, retry: false };
  return { kind: 'failed', text: WITHDRAW_TEXT.server, retry: true };
}
