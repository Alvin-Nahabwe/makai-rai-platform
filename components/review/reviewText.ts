import type { ApiErrorBody, SealView, StageReviewView } from '@/types/api';
import type { Stage } from '@/types/record';
import type { SealPreview } from '@/lib/data/reviews';
import { formatDay, formatTime } from '@/lib/format/dates';
import { formatFingerprint } from '@/lib/seal/format';
import { REVIEW_COPY } from '@/lib/review/copy';

/**
 * The sentences of S-16, S-17 and the review slots (W-7; 7.4.2 row S-16 / S-17, SRS line 2385; UX-18; M-28), built as
 * pure functions from the words in lib/review/copy.ts, so the server pages, the client components and the tests read
 * one copy. No markup: every state is a sentence (NFR-A11Y-05, SC 1.4.1). Imported by client components, so it imports
 * types and pure modules only.
 */

/** The review's state in one line (W-7 note 1; S-10's "Changed since seal 1 (2)"); a damaged seal is said first. */
export function reviewStateLine(v: StageReviewView): string {
  const seal = v.latestSeal;
  if (seal === null) return REVIEW_COPY.state.notSealed;
  if (v.latestSealUnreadable || !seal.bytesMatch) return REVIEW_COPY.state.damaged;   // Task 18 Q3 (b) (SRS 7.5.3 bans every form of "fail")
  if (v.changed !== null) return REVIEW_COPY.state.changed(v.changed.sealNumber, v.changed.changedQuestions.length + v.changed.changedFindings.length);
  return REVIEW_COPY.state.sealed(seal.sealNumber, formatDay(seal.sealedAt));
}

/** M-28, shown after sealing, in the device's zone when `zone` is not given. */
export function sealedMessage(s: SealView, zone?: string): string {
  return REVIEW_COPY.confirm.sealed(s.sealNumber, formatDay(s.sealedAt, zone), formatTime(s.sealedAt, zone), formatFingerprint(s.fingerprint, 'short'));
}

/** UX-18's first line on S-17, null when there is no unsaved decision of the stage in this browser. Its link sits beside it. */
export function unsavedDraftsLine(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? REVIEW_COPY.confirm.unsavedOne : REVIEW_COPY.confirm.unsavedMany(n);
}

/** "1 file", "2 files": the count with its noun (S-17's lines and the S-11 banner). */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The decision statuses in the order the seal step counts them. */
export const PREVIEW_STATUSES = ['done', 'partly', 'not_yet', 'not_applicable'] as const;

/** What the seal will hold, in the parts S-17 draws: the statement, the two count tables (S7) and the other lines. */
export type PreviewParts = {
  statement: string;
  /** C 182: one row per status, every status, a zero included. */
  statuses: ReadonlyArray<{ status: (typeof PREVIEW_STATUSES)[number]; count: number }>;
  /** C 183: one row per reason code used, its label or (C11) the code itself when the content has no label for it. */
  reasons: ReadonlyArray<{ code: string; label: string; count: number }>;
  lines: readonly string[];
};

/**
 * What the seal will hold (W-7 S-17; UX-18; FR-REV-02). `sealNumber` is the number the seal will take; `reasonLabels`
 * maps the running content's reason codes to their labels (a code without one is shown as itself). The questions with
 * no decision are rendered by the page as links, so they are not here.
 */
export function previewParts(p: SealPreview, sealNumber: number, reasonLabels: Readonly<Record<string, string>>): PreviewParts {
  const c = REVIEW_COPY.sealPage;
  const lines: string[] = [];
  if (p.scopeAnswer !== null) lines.push(c.gateAnswer(REVIEW_COPY.gateWords[p.scopeAnswer.answer]));
  lines.push(
    c.doneNoEvidence(p.doneWithoutEvidence),
    c.openFindings(p.openFindings),
    c.openMitigations(p.openMitigations),
    c.evidence(plural(p.evidence.files, 'file', 'files'), plural(p.evidence.links, 'link', 'links')),
    c.enteredBy(plural(p.enteredByPeople, 'person', 'people')),
    c.reworded(p.rewordedSinceDecision),
    c.sealingAs(p.sealer.name, REVIEW_COPY.roleWords[p.sealer.role]),
  );
  return {
    statement: c.statement(sealNumber),
    statuses: PREVIEW_STATUSES.map((status) => ({ status, count: p.byStatus[status] })),
    reasons: Object.entries(p.byReasonCode).map(([code, count]) => ({ code, label: reasonLabels[code] ?? code, count })),
    lines,
  };
}

/** The same as text, one line each, the statement first: the counts by status and by reason as one line each. */
export function previewLines(p: SealPreview, sealNumber: number, reasonLabels: Readonly<Record<string, string>>): string[] {
  const parts = previewParts(p, sealNumber, reasonLabels);
  const c = REVIEW_COPY.sealPage;
  const lines = [parts.statement, c.byStatus(p.byStatus.done, p.byStatus.partly, p.byStatus.not_yet, p.byStatus.not_applicable)];
  if (parts.reasons.length > 0) lines.push(c.byReason(parts.reasons.map((r) => `${r.label} ${r.count}`).join('\u00a0· ')));
  return [...lines, ...parts.lines];
}

/** The sealing states of 7.4.2 row S-16 / S-17; `lost` is followed by a Retry button (owner question B5). */
export const SEAL_STATUS = Object.freeze({
  sending: REVIEW_COPY.confirm.sending,
  slow: REVIEW_COPY.confirm.slow,
  // Task 18 Q1: the seal may have arrived, and Retry replays the same request id, so "It will not seal twice." is true.
  lost: REVIEW_COPY.confirm.lost,
});

/** The path to the next seal (7.4.2 "Sealed" cell). */
export function sealAgainLabel(nextNumber: number): string {
  return REVIEW_COPY.review.sealAgain(nextNumber);
}

/** The unsaved decisions' link: S-11 with its drafts filter (DEC-b's address, contract G023). */
export function draftsHref(orgSlug: string, projectId: string, stage: Stage): string {
  return `/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectId)}/stages/${stage}?show=drafts`;
}

/**
 * "What sealing means" (AL-2's link, contract G050): Help's section of that name (plan 1A Task 12, W2). The link's words are
 * HELP_COPY.sealing.heading, imported by the server pages that print it; this module is imported by client components, so
 * it does not import the Help copy itself (ruling X-2).
 */
export const SEAL_PROOF_HREF = '/help#what-sealing-means';

/**
 * The question-set line (controller ruling on RE-5, owner copy): shown when the content running now is not the one the
 * latest seal was taken on, since "changed since seal" is counted against the running question set (FR-REV-05).
 */
export function contentChangedLine(latestSeal: SealView | null, runningSemver: string): string | null {
  if (latestSeal === null || latestSeal.contentSemver === runningSemver) return null;
  return REVIEW_COPY.state.contentChanged(latestSeal.sealNumber);
}

/** What a refused write shows (UX-25: said once, assertively), whether Retry can help, and whether the page reloads. */
export type RefusalLine = { message: string; retry: boolean; refresh: boolean };
type Refused = { status: number; body: Pick<ApiErrorBody, 'code'> & { retryAfterSeconds?: number } };

const waitMinutes = (seconds: number | undefined) => {
  const n = typeof seconds === 'number' && seconds > 0 ? Math.ceil(seconds / 60) : 1;
  return n === 1 ? REVIEW_COPY.waitOne : REVIEW_COPY.waitMany(n);
};

/**
 * S-17's refusals (C4 CR-1, CR-4, SF-5; owner copy for number_taken and the sign-out). Retry is offered only for a
 * server failure, where the same request id may still succeed; a taken number reloads the page so the button shows
 * the next one; a sign-out, a rate limit, a lowered role (M-09) and an archived project (M-12) say what to do instead.
 */
export function sealRefusal(out: Refused, sealNumber: number): RefusalLine {
  const { status, body } = out;
  if (body.code === 'number_taken') {
    return { message: REVIEW_COPY.confirm.numberTaken(sealNumber), retry: false, refresh: true };
  }
  if (status === 401) return { message: REVIEW_COPY.confirm.signedOut, retry: false, refresh: false };
  if (status === 429 || body.code === 'rate_limited') return { message: REVIEW_COPY.confirm.rateLimited(waitMinutes(body.retryAfterSeconds)), retry: false, refresh: false };
  // M-12 and M-09's patterns for a seal (C4 CR-6 ruling, owner copy): nothing is kept on the device.
  if (body.code === 'project_archived') return { message: REVIEW_COPY.confirm.archived, retry: false, refresh: false };
  if (status === 403 && body.code === 'forbidden') return { message: REVIEW_COPY.confirm.roleChanged, retry: false, refresh: false };
  return { message: REVIEW_COPY.confirm.server, retry: status >= 500, refresh: false };
}

/** The open form's refusals other than a field error, on the same rules; the form's own button is its retry. */
export function openRefusal(out: Refused): RefusalLine {
  const { status, body } = out;
  if (body.code === 'number_taken') {
    return { message: REVIEW_COPY.open.numberTaken, retry: false, refresh: true };
  }
  if (status === 401) return { message: REVIEW_COPY.open.signedOut, retry: false, refresh: false };
  if (status === 429 || body.code === 'rate_limited') return { message: REVIEW_COPY.open.rateLimited(waitMinutes(body.retryAfterSeconds)), retry: false, refresh: false };
  if (body.code === 'project_archived') return { message: REVIEW_COPY.open.archived, retry: false, refresh: false };
  if (status === 403 && body.code === 'forbidden') return { message: REVIEW_COPY.open.roleChanged, retry: false, refresh: false };
  return { message: REVIEW_COPY.open.server, retry: status >= 500, refresh: false };
}

/**
 * Whether a 2xx body is the seal route 13 answers (S-17 hunt H2): a reply that is not is treated as "may have been
 * sealed", so the same request id is kept and Retry replays it, instead of the page breaking on a bad fingerprint.
 */
export function isSealBody(v: unknown): v is SealView {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s.id === 'string' && s.id !== '' && Number.isInteger(s.sealNumber) && typeof s.sealedAt === 'string'
    && typeof s.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(s.fingerprint);
}

/** Whether a 2xx body is the review route 12 answers, with an id to go to. */
export function isReviewBody(v: unknown): v is StageReviewView {
  return typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string' && (v as { id: string }).id !== '';
}

/**
 * The open form's lost reply (Task 18 Q1). Pressing the form's button again replays the same request id for the same
 * stage and note (requestIdFor), so "It will not open twice." is true.
 */
export const OPEN_LOST = REVIEW_COPY.open.lost;
