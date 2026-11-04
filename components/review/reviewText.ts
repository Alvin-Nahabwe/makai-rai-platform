import type { ApiErrorBody, SealView, StageReviewView } from '@/types/api';
import { ARCHIVED_TEXT, ROLE_CHANGED_TEXT } from '@/lib/evidence/copy';
import type { ScopeAnswer, Stage } from '@/types/record';
import type { SealPreview } from '@/lib/data/reviews';
import { formatDay, formatTime } from '@/lib/format/dates';
import { formatFingerprint } from '@/lib/seal/format';

/**
 * The words of S-16, S-17 and the review slots (W-7; 7.4.2 row S-16 / S-17, SRS line 2385; UX-18; M-28), as pure
 * functions, so the server pages, the client components and the tests read one copy. No markup: every state is a
 * sentence (NFR-A11Y-05, SC 1.4.1). Imported by client components, so it imports types and pure modules only.
 */

/** The review's state in one line (W-7 note 1; S-10's "Changed since seal 1 (2)"); a damaged seal is said first. */
export function reviewStateLine(v: StageReviewView): string {
  const seal = v.latestSeal;
  if (seal === null) return 'Never sealed.';
  if (v.latestSealUnreadable || !seal.bytesMatch) return 'Does not match the record.';   // M-29's sentence (SRS 7.5.3 bans every form of "fail")
  if (v.changed !== null) return `Changed since seal ${v.changed.sealNumber} (${v.changed.changedQuestions.length + v.changed.changedFindings.length}).`;
  return `Sealed as seal ${seal.sealNumber} on ${formatDay(seal.sealedAt)}.`;
}

/** M-28, shown after sealing, in the device's zone when `zone` is not given. */
export function sealedMessage(s: SealView, zone?: string): string {
  return `Sealed as seal ${s.sealNumber} on ${formatDay(s.sealedAt, zone)} at ${formatTime(s.sealedAt, zone)}. Fingerprint ${formatFingerprint(s.fingerprint, 'short')}.`;
}

/** UX-18's first line on S-17, null when there is no unsaved answer of the stage on this device. "[Go to them]" sits beside it. */
export function unsavedDraftsLine(n: number): string | null {
  return n > 0 ? `You have ${n} unsaved answers in this stage on this device. They will not be in the seal.` : null;
}

const SCOPE_WORDS: Record<ScopeAnswer, string> = { yes: 'Yes', no: 'No', not_sure: 'Not sure' };
/** "1 file", "2 files": the count with its noun (S-17's lines and the S-11 banner). */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What the seal will hold (W-7 S-17; UX-18; FR-REV-02), one line each, the statement first. `sealNumber` is the number
 * the seal will take; `reasonLabels` maps the running content's reason codes to their labels (a code without one is
 * shown as itself). The questions with no decision are rendered by the page as links, so they are not here.
 */
export function previewLines(p: SealPreview, sealNumber: number, reasonLabels: Readonly<Record<string, string>>): string[] {
  const lines = [
    `A seal fixes what the record says right now, gaps included. It does not hide open items; it records them. After sealing, any change shows as "changed since seal ${sealNumber}".`,
    `Decisions by status: Done ${p.byStatus.done} . Partly ${p.byStatus.partly} . Not yet ${p.byStatus.not_yet} . Not applicable ${p.byStatus.not_applicable}`,
  ];
  const reasons = Object.entries(p.byReasonCode);
  if (reasons.length > 0) lines.push(`Not applicable and Not yet by reason: ${reasons.map(([code, n]) => `${reasonLabels[code] ?? code} ${n}`).join(' . ')}`);
  if (p.scopeAnswer !== null) lines.push(`Scope answer: ${SCOPE_WORDS[p.scopeAnswer.answer]} (${p.scopeAnswer.questionId}, version ${p.scopeAnswer.versionNumber})`);
  lines.push(
    `Done without evidence: ${p.doneWithoutEvidence}`,
    `Open findings: ${p.openFindings}`,
    `Open mitigations: ${p.openMitigations}`,
    `Evidence: ${plural(p.evidence.files, 'file', 'files')} (fingerprints taken of each file), ${plural(p.evidence.links, 'link', 'links')} (the address only; the platform never opens links)`,
    `Decisions entered by ${plural(p.enteredByPeople, 'person', 'people')}`,
    `Expected practice reworded since the decision: ${p.rewordedSinceDecision}`,
    `You are sealing as ${p.sealer.name} (${p.sealer.role})`,
  );
  return lines;
}

/** The sealing states of 7.4.2 row S-16 / S-17; `lost` is followed by a Retry button (owner question B5). */
export const SEAL_STATUS = Object.freeze({
  sending: 'Sealing...',
  slow: 'Still sealing. The connection is slow.',
  lost: 'Not sealed: connection lost. Nothing was sealed.',
});

/** The path to the next seal (7.4.2 "Sealed" cell). */
export function sealAgainLabel(nextNumber: number): string {
  return `Seal again as seal ${nextNumber}`;
}

/** "[Go to them]": S-11 with its drafts filter (DEC-b's address, contract G023). */
export function draftsHref(orgSlug: string, projectId: string, stage: Stage): string {
  return `/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectId)}/stages/${stage}?show=drafts`;
}

/** "What a seal proves" (AL-2's link; PUB's About anchor, contract G050). */
export const SEAL_PROOF_HREF = '/about#what-a-seal-proves';

/**
 * The question-set line (controller ruling on RE-5, owner copy): shown when the content running now is not the one the
 * latest seal was taken on, since "changed since seal" is counted against the running question set (FR-REV-05).
 */
export function contentChangedLine(latestSeal: SealView | null, runningSemver: string): string | null {
  if (latestSeal === null || latestSeal.contentSemver === runningSemver) return null;
  return `The question set changed after seal ${latestSeal.sealNumber} (version ${latestSeal.contentSemver} to ${runningSemver}). Changes are counted against the current question set.`;
}

/** What a refused write shows (UX-25: said once, assertively), whether Retry can help, and whether the page reloads. */
export type RefusalLine = { message: string; retry: boolean; refresh: boolean };
type Refused = { status: number; body: Pick<ApiErrorBody, 'code'> & { retryAfterSeconds?: number } };

const waitMinutes = (seconds: number | undefined) => {
  const n = typeof seconds === 'number' && seconds > 0 ? Math.ceil(seconds / 60) : 1;
  return `Wait ${n} minute${n === 1 ? '' : 's'}, then retry.`;
};

/**
 * S-17's refusals (C4 CR-1, CR-4, SF-5; owner copy for number_taken and the sign-out). Retry is offered only for a
 * server failure, where the same request id may still succeed; a taken number reloads the page so the button shows
 * the next one; a sign-out, a rate limit, a lowered role (M-09) and an archived project (M-12) say what to do instead.
 */
export function sealRefusal(out: Refused, sealNumber: number): RefusalLine {
  const { status, body } = out;
  if (body.code === 'number_taken') {
    return { message: `Not sealed: seal ${sealNumber} was taken by someone else just now. Nothing was sealed by this press. The next seal is seal ${sealNumber + 1}.`, retry: false, refresh: true };
  }
  if (status === 401) return { message: 'Not sealed: you have been signed out. Sign in again to seal.', retry: false, refresh: false };
  if (status === 429 || body.code === 'rate_limited') return { message: `Not sealed: too many requests. ${waitMinutes(body.retryAfterSeconds)}`, retry: false, refresh: false };
  if (body.code === 'project_archived') return { message: ARCHIVED_TEXT, retry: false, refresh: false };
  if (status === 403 && body.code === 'forbidden') return { message: ROLE_CHANGED_TEXT, retry: false, refresh: false };
  return { message: 'Not sealed: the server had a problem. Nothing was sealed.', retry: status >= 500, refresh: false };
}

/** The open form's refusals other than a field error, on the same rules; the form's own button is its retry. */
export function openRefusal(out: Refused): RefusalLine {
  const { status, body } = out;
  if (body.code === 'number_taken') {
    return { message: 'Not opened: another review of this stage was opened at the same moment. The name above is updated; open again.', retry: false, refresh: true };
  }
  if (status === 401) return { message: 'Not opened: you have been signed out. Sign in again.', retry: false, refresh: false };
  if (status === 429 || body.code === 'rate_limited') return { message: `Not opened: too many requests. ${waitMinutes(body.retryAfterSeconds)}`, retry: false, refresh: false };
  if (body.code === 'project_archived') return { message: ARCHIVED_TEXT, retry: false, refresh: false };
  if (status === 403 && body.code === 'forbidden') return { message: ROLE_CHANGED_TEXT, retry: false, refresh: false };
  return { message: 'Not opened: the server had a problem. Retry.', retry: status >= 500, refresh: false };
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
