import { declaredDateFromParts, utcPlus14Date, validateDecisionFields, type DateParts } from '@/lib/decision/rules';
import { DECISION_OUTCOME_COPY } from '@/lib/decision/outcome/copy';
import type { DraftKey, DraftStore, StoredDraft } from '@/lib/client/drafts';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { LoadedQuestion } from '@/types/content';
import { can } from '@/lib/authz/policy';
import type { OrgRole } from '@prisma/client';
import type { DecisionVersionView, DeciderView, SaveDecisionRequest } from '@/types/api';
import type { Decider, DecisionStatus, DeclaredDate, FieldError, ReasonCode, ScopeAnswer } from '@/types/record';

/**
 * The answer a person is writing on S-12, as the form holds it and as the per-account draft store keeps it
 * (UX-26, NFR-PRIV-06): the form's fields, the evidence ids it holds, the names of files still uploading and
 * the question's address. Nothing else: no file bytes, no other person's data. Plain TypeScript with no
 * React and no server import, so the client form imports it.
 */
export interface DecisionDraft {
  status: DecisionStatus | null; scopeAnswer: ScopeAnswer | null; optionsInPlace: string[]; reasonCode: string | null;
  reason: string; decidedBy: Decider | null; date: DateParts; evidenceIds: string[]; notUploaded: string[]; href: string;
  /**
   * Whether the person changed "Decided by" or "Decided on" in this draft. Only then does a restore trust the stored
   * decider and date; otherwise it applies the defaults (design 2026-11-22 section 8). A draft saved by v0.9.0 has no
   * such field: it counts as changed when its date was typed (any part of it is not empty), and as unchanged otherwise
   * (`restoreDraft`).
   */
  whoWhenChanged: boolean;
}

/** A draft as the store may hold it: one saved by v0.9.0 lacks `whoWhenChanged`, which `restoreDraft` reads from the typed date. */
export type StoredDecisionDraft = Omit<DecisionDraft, 'whoWhenChanged'> & { whoWhenChanged?: boolean };

export const EMPTY_DATE: DateParts = Object.freeze({ day: '', month: '', year: '' }) as DateParts;

/** S-12's address, the draft's `href` (S-11 and S-21 link to it). */
export function questionHref(data: Pick<QuestionPanelData, 'orgSlug' | 'projectId' | 'stage'>, questionId: string): string {
  return `/orgs/${data.orgSlug}/projects/${data.projectId}/stages/${data.stage}/questions/${questionId}`;
}

/** The draft store key of this question for this account (UX-26): the account and organisation come from the server. */
export function draftKeyFor(data: QuestionPanelData): DraftKey {
  return { userId: data.viewer.userId, orgId: data.orgId, projectId: data.projectId, target: { kind: 'question', questionId: data.question.id } };
}

function deciderOf(v: DeciderView | null): Decider | null {
  if (v === null) return null;
  return v.kind === 'member' ? { kind: 'member', userId: v.user.userId } : { kind: 'outside_role', role: v.role };
}

/** Whether a version is a decision the form can open from (a withdrawal is no decision, 5.3 item 2). */
export const isDecision = (v: DecisionVersionView | null): v is DecisionVersionView => v !== null && v.status !== 'withdrawn';

/**
 * FR-DEC-01: a new version opens from the current version's fields. Who and when open filled in (the owner's rulings of
 * 19 and 22 Nov 2026, design 2026-11-22 section 2 item 1): "Decided by" is the viewer on a first answer and after a
 * withdrawal, and the current version's decider on a change (the viewer if that version names none); "Decided on" is
 * `today`, the device's date as three boxes, or empty when `today` is null (the server render, which does not know the
 * reader's day). `whoWhenChanged` starts false: the person has not yet touched either.
 */
export function draftFromCurrent(data: QuestionPanelData, today: DateParts | null): DecisionDraft {
  const href = questionHref(data, data.question.id);
  const viewer: Decider = { kind: 'member', userId: data.viewer.userId };
  const date = { ...(today ?? EMPTY_DATE) };
  const c = data.current;
  if (!isDecision(c)) {
    return { status: null, scopeAnswer: null, optionsInPlace: [], reasonCode: null, reason: '', decidedBy: viewer,
      date, evidenceIds: [], notUploaded: [], href, whoWhenChanged: false };
  }
  return {
    status: c.status as DecisionStatus | null, scopeAnswer: c.scopeAnswer, optionsInPlace: [...c.optionsInPlace], reasonCode: c.reasonCode,
    reason: c.reason ?? '', decidedBy: deciderOf(c.decidedBy) ?? viewer,
    date, evidenceIds: c.evidence.map((e) => e.id), notUploaded: [], href, whoWhenChanged: false,
  };
}

/** The three date fields of a declared date at its precision (the form's two date shortcuts). */
export function dateParts(d: DeclaredDate): DateParts {
  const [year, month, day] = d.split('-');
  return { year: year ?? '', month: month === undefined ? '' : String(Number(month)), day: day === undefined ? '' : String(Number(day)) };
}

/**
 * The field errors the browser finds before sending (M-11, 7.4.1 "Validation errors"), with DEC-a's shared rules,
 * so the browser and the server refuse the same input with the same text. The latest date allowed is the
 * device's today in UTC+14 (FR-DEC-02). A date the three fields cannot form is reported once, on its field.
 */
export function draftErrors(d: DecisionDraft, data: QuestionPanelData, now: Date): FieldError[] {
  const parsed = declaredDateFromParts(d.date);
  const dateError = 'field' in parsed ? parsed : null;
  const errors = validateDecisionFields({
    questionType: data.question.type, options: data.question.options ?? [], reasonCodes: data.reasonCodes,
    status: data.question.type === 'gate' ? null : d.status, scopeAnswer: data.question.type === 'gate' ? d.scopeAnswer : null,
    optionsInPlace: data.question.type === 'checklist' ? d.optionsInPlace : [], reasonCode: d.reasonCode, reason: d.reason,
    decidedBy: d.decidedBy, declaredDate: dateError === null ? (parsed as { date: DeclaredDate }).date : null,
  }, utcPlus14Date(now));
  return dateError === null ? errors : [...errors.filter((e) => e.field !== 'declaredDate'), dateError];
}

/**
 * Route 1's body for this draft, without the request id (contract route row 1): only the fields the question's
 * type takes, the base the person is saving over, and the declared date the three fields form. Call it only on
 * a draft `draftErrors` passed: a date the fields cannot form is sent as '' and the server refuses it.
 */
export function toSaveBody(
  d: DecisionDraft, data: Pick<QuestionPanelData, 'stage'> & { question: Pick<LoadedQuestion, 'id' | 'type'> }, base: number | null,
): Omit<SaveDecisionRequest, 'requestId'> {
  const gate = data.question.type === 'gate';
  const parsed = declaredDateFromParts(d.date);
  return {
    stage: data.stage, questionId: data.question.id, baseVersionNumber: base,
    status: gate ? null : d.status, scopeAnswer: gate ? d.scopeAnswer : null,
    optionsInPlace: data.question.type === 'checklist' ? [...d.optionsInPlace] : [],
    reasonCode: (d.status === 'not_yet' || d.status === 'not_applicable') && !gate ? (d.reasonCode as ReasonCode | null) : null,
    reason: d.reason, decidedBy: d.decidedBy as Decider, declaredDate: 'field' in parsed ? '' : parsed.date,
    evidenceIds: [...d.evidenceIds],
  };
}

/**
 * FR-DEC-08 (SRS line 779): owners and admins withdraw any current decision; an assessor only one they entered; nobody
 * a withdrawal, and nobody in an archived project. Advice for the page: route 2 applies the same rule on the version it
 * reads in its own transaction (DEC-a obligation D3).
 */
export function canWithdrawVersion(role: OrgRole, viewerId: string, current: DecisionVersionView | null, projectArchived: boolean): boolean {
  if (projectArchived || current === null || current.status === 'withdrawn' || !can(role, 'decision:withdraw')) return false;
  if (role === 'owner' || role === 'admin') return true;
  return current.enteredBy.userId === viewerId;
}

/** A stored value that has the draft's shape; anything else (an older shape, a hand edit) is ignored (S-12, S-11). */
export function isDraftValue(v: unknown): v is StoredDecisionDraft {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string');
  const date = d.date as Record<string, unknown> | null;
  return typeof d.reason === 'string' && strings(d.optionsInPlace) && strings(d.evidenceIds) && strings(d.notUploaded)
    && typeof date === 'object' && date !== null && ['day', 'month', 'year'].every((k) => typeof date[k] === 'string')
    && (d.status === null || typeof d.status === 'string') && (d.scopeAnswer === null || typeof d.scopeAnswer === 'string')
    && (d.reasonCode === null || typeof d.reasonCode === 'string') && (d.decidedBy === null || typeof d.decidedBy === 'object')
    && (d.whoWhenChanged === undefined || typeof d.whoWhenChanged === 'boolean');
}

/**
 * The draft a stored value restores to on open, or null when it is not a draft (`isDraftValue`). Everything the person
 * typed comes back, and `href` is this page's. Who and when come back only when the draft says the person changed them
 * (`whoWhenChanged`); otherwise they take today's defaults, so a decider or a date from an older day is never trusted
 * unseen (design 2026-11-22 section 4 and section 8).
 *
 * A draft with no such field was saved by v0.9.0, where the date always opened empty: a date in it was typed by the
 * person, so it is kept with its decider (the default one when the draft has none), and the draft counts as changed.
 * A flagless draft with an empty date takes the defaults (controller ruling, answer cost 3 fix round 1).
 */
export function restoreDraft(found: unknown, data: QuestionPanelData, today: DateParts | null): DecisionDraft | null {
  if (!isDraftValue(found)) return null;
  const defaults = draftFromCurrent(data, today);
  const typedDate = found.date.day !== '' || found.date.month !== '' || found.date.year !== '';
  const changed = found.whoWhenChanged === undefined ? typedDate : found.whoWhenChanged;
  return {
    ...found, href: defaults.href,
    decidedBy: changed ? (found.decidedBy ?? defaults.decidedBy) : defaults.decidedBy,
    date: changed ? found.date : defaults.date,
    whoWhenChanged: changed,
  };
}

/**
 * A change to the draft's fields. A patch that carries "Decided by" or "Decided on" records that the person changed who
 * or when, so a restore keeps them (`restoreDraft`); any other patch leaves the record as it was. Pure.
 */
export function patchDraft(value: DecisionDraft, patch: Partial<DecisionDraft>): DecisionDraft {
  return { ...value, ...patch, ...('decidedBy' in patch || 'date' in patch ? { whoWhenChanged: true } : {}) };
}

/** The line for evidence a restored draft holds that the evidence block cannot name (S-12 and W-4's "Your version"). */
export function keptEvidenceLine(n: number): string {
  return DECISION_OUTCOME_COPY.keptEvidence(n);
}

/**
 * Whether this device holds the answer when a 403 gate reply arrives, so the form may navigate away (CR-2). Decided
 * then, not at the press: a write refused while the save was out removes the older draft under the key (DraftStore
 * write), so the press-time result is no evidence. Writes the answer the field holds now, then reads it back; false
 * when there is no store, the write is refused, or the read does not return that answer.
 */
export function draftHeldForGate<V>(store: DraftStore | null, key: DraftKey, d: StoredDraft<V>, now: Date): boolean {
  if (store === null || !store.write(key, d)) return false;
  const back = store.read<V>(key, now);
  return back !== null && JSON.stringify(back.value) === JSON.stringify(d.value);
}
