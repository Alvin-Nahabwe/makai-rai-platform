import { draftKey, type DraftKey, type DraftStore } from '@/lib/client/drafts';
import type { RetryState, SendOutcome } from '@/lib/client/retrySafeWrite';
import { formatTime } from '@/lib/format/dates';
import { OUTSIDE_ROLE_LABELS } from '@/lib/decision/copy';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { STAGES, type CalendarDate, type Decider, type FieldError, type MitigationStatus } from '@/types/record';
import type { EvidenceItemView, FindingClosedConflict, MitigationVersionView } from '@/types/api';

/**
 * The client half of S-14's and S-15's forms (SRS 7.4.2 S-14 and S-15 rows, 7.4.3, 7.4.4, 7.5.7): the mirror of the
 * server's 422s, the texts a saved or refused write shows, and the draft key. Plain TypeScript with no React and no
 * server import, so client components and unit tests import it. A rule here only saves a round trip; every rule is
 * checked again by the route (the field texts are FND-a's, `lib/findings/validate.ts`, and route 5's).
 */

// ─── What a write answered ───────────────────────────────────────────────────────────────────────

/** The sentence after an unsaved write that says where the person's words are. M-05 to M-09 end with these. */
export const KEPT_ON_DEVICE = FINDINGS_COPY.failures.keptInBrowser;
export const KEPT_IN_FORM = FINDINGS_COPY.failures.keptInForm;

/** The one sentence a field shows when the server's text for it is not one of ours (FND-a RE-2): never a raw API string. */
export const GENERIC_FIELD_TEXT = FINDINGS_COPY.genericField;

/**
 * The field texts a form may show, which are the server's own (7.4.2 S-14 and S-15 rows; `lib/findings/validate.ts`; route 5):
 * every text of `FINDINGS_COPY.fields`, the one group the server's messages and the forms' own checks read.
 */
export const FIELD_TEXTS: ReadonlySet<string> = new Set(Object.values(FINDINGS_COPY.fields));
const TOO_LONG = /^This is [\d,]+ characters\. The limit is [\d,]+\.$/;

/** The text a field shows for the server's message on it: the message when it is one of ours, else the fixed sentence. */
export function fieldText(message: string): string {
  return FIELD_TEXTS.has(message) || TOO_LONG.test(message) ? message : GENERIC_FIELD_TEXT;
}

/** What to show after a write that did not save: a sentence for `role="alert"`, the field errors to place, and a conflict body to render. */
export interface WriteFailure {
  text: string;
  fields: FieldError[];
  /** The body of a 409 the form renders itself (`base_version_moved`'s newer version). */
  conflict: { code: string; current: unknown } | null;
  /** The name inside `text` that a view must wrap in <bdi> (a member's name can carry direction controls). */
  nameInText?: string;
  /** True for a failure that Retry (same request id) may fix: no reply, a cut connection, a 5xx. */
  retry: boolean;
}

const isClosed = (v: unknown): v is FindingClosedConflict =>
  typeof v === 'object' && v !== null && typeof (v as FindingClosedConflict).state === 'string'
  && typeof (v as FindingClosedConflict).at === 'string' && typeof (v as FindingClosedConflict).by?.name === 'string';

/** 7.4.4: "This finding was closed by <who> at <time>." The time is in the device's zone. */
export function closedByText(c: FindingClosedConflict, timeZone?: string): string {
  return FINDINGS_COPY.failures.closedBy(c.by.name, formatTime(c.at, timeZone));
}

/**
 * The failure a write's outcome shows, or `null` when it saved. `kept` is the sentence that says where the words are
 * (`KEPT_ON_DEVICE` for a form with a draft, `KEPT_IN_FORM` for the others). The texts are M-05 to M-09 and M-12 (SRS
 * 7.5.7), 7.4.4's closed-finding sentence, and, for the refusals the SRS words no text for, one plain sentence each.
 * `again` is the action's own button label for a form with no Retry button (ruling L5-5); omitted, the lines say "Select Retry.".
 */
export function writeFailure(outcome: SendOutcome<unknown>, kept: string, timeZone?: string, again?: string): WriteFailure | null {
  if (outcome.kind === 'saved') return null;
  const base = { fields: [] as FieldError[], conflict: null, retry: false };
  if (outcome.kind === 'not_saved') {
    return outcome.reason === 'timeout'
      ? { ...base, retry: true, text: FINDINGS_COPY.failures.noReply(kept, again) }
      : { ...base, retry: true, text: FINDINGS_COPY.failures.connectionLost(kept, again) };
  }
  const { status, body } = outcome;
  if (status === 401) return { ...base, text: FINDINGS_COPY.failures.signedOut(kept) };
  if (status === 403) return { ...base, text: FINDINGS_COPY.failures.forbidden(kept) };
  if (status === 409) {
    if (body.code === 'project_archived') return { ...base, text: FINDINGS_COPY.failures.archived };
    if (body.code === 'finding_not_open') {
      return isClosed(body.current)
        ? { ...base, text: closedByText(body.current, timeZone), nameInText: body.current.by.name }
        : { ...base, text: FINDINGS_COPY.failures.closed };
    }
    if (body.code === 'base_version_moved') return { ...base, text: FINDINGS_COPY.failures.newerFirst, conflict: { code: body.code, current: body.current } };
    if (body.code === 'finding_already_open') return { ...base, text: FINDINGS_COPY.failures.alreadyOpen };
    if (body.code === 'finding_withdrawn') return { ...base, text: FINDINGS_COPY.failures.withdrawn };
    if (body.code === 'cannot_withdraw_shortfall') return { ...base, text: FINDINGS_COPY.failures.cannotWithdrawShortfall };
    if (body.code === 'finding_has_open_work') return { ...base, text: FINDINGS_COPY.failures.openWork };
  }
  if (status === 422 && body.fields !== undefined && body.fields.length > 0) {
    const fields = body.fields.map((f) => ({ field: f.field, message: fieldText(f.message) }));
    return { ...base, fields, text: FINDINGS_COPY.failures.entry(fields.length) };
  }
  if (status === 404) return { ...base, text: FINDINGS_COPY.failures.outOfDate };
  if (status === 429) return { ...base, retry: true, text: FINDINGS_COPY.failures.tooMany(kept, again) };
  if (status >= 400 && status < 500) return { ...base, text: FINDINGS_COPY.failures.refused(kept) };
  return { ...base, retry: true, text: FINDINGS_COPY.failures.server(kept, again) };
}

// ─── Raising a team finding (S-14) and the reason of a reopen or a withdrawal (S-15) ────────────


/** Code points of the trimmed text after Unicode NFC: the count the server limits by (`lib/findings/validate.ts` `textLength`). */
export function charCount(s: string): number {
  return Array.from(s.trim().normalize('NFC')).length;
}

/** The server's text for a text over its limit (`FINDING_MESSAGES.tooLong`). */
export const tooLongText = (n: number, max: number): string => FINDINGS_COPY.tooLong(n, max);

export const TITLE_MAX = 200;
export const TEXT_MAX = 4000;

export interface RaiseFormValue { title: string; description: string; stage: string; riskArea: string }

/** The client mirror of route 5's 422s for the fields a person types (7.4.2 S-14 row: "Write a title." "Choose a stage."). */
export function raiseFormErrors(v: RaiseFormValue): FieldError[] {
  const errors: FieldError[] = [];
  const title = charCount(v.title);
  if (title === 0) errors.push({ field: 'title', message: FINDINGS_COPY.fields.title });
  else if (title > TITLE_MAX) errors.push({ field: 'title', message: tooLongText(title, TITLE_MAX) });
  const description = charCount(v.description);
  if (description === 0) errors.push({ field: 'description', message: FINDINGS_COPY.fields.description });
  else if (description > TEXT_MAX) errors.push({ field: 'description', message: tooLongText(description, TEXT_MAX) });
  if (!(STAGES as readonly string[]).includes(v.stage)) errors.push({ field: 'stage', message: FINDINGS_COPY.fields.stage });
  return errors;
}

/** A reopen's or a withdrawal's reason: 1 to 4,000 characters (routes 9 and 10). */
export function reasonErrors(reason: string): FieldError[] {
  const n = charCount(reason);
  if (n === 0) return [{ field: 'reason', message: FINDINGS_COPY.fields.eventReason }];
  return n > TEXT_MAX ? [{ field: 'reason', message: tooLongText(n, TEXT_MAX) }] : [];
}

/** The live count under a long text: "96 / 4,000 characters" (UX-12's form; W-6). */
export const characterCount = (n: number, max = TEXT_MAX): string => FINDINGS_COPY.count(n, max);

// ─── The mitigation form (S-15; FR-FND-03, FR-FND-04, UX-16, UX-26, UX-30) ─────────────────────


export interface MitigationFormValue {
  what: string; ownerUserId: string; due: { day: string; month: string; year: string }; status: MitigationStatus;
  followsControl: string | null; evidence: EvidenceItemView[]; uploading: string[]; noArtefact: boolean;
  closureNote: string; cancelReason: string; changeNote: string;
}

/** A new mitigation's form: planned, nothing chosen. */
export function emptyMitigationValue(base: MitigationVersionView | null): MitigationFormValue {
  return base === null
    ? { what: '', ownerUserId: '', due: { day: '', month: '', year: '' }, status: 'planned', followsControl: null, evidence: [], uploading: [],
      noArtefact: false, closureNote: '', cancelReason: '', changeNote: '' }
    : valueOf(base);
}

/** The form's value starting from a stored version (an update opens from the current one; W-5 note 3). */
export function valueOf(v: MitigationVersionView): MitigationFormValue {
  const [year, month, day] = v.dueDate.split('-');
  return {
    what: v.what ?? '', ownerUserId: v.owner.userId, due: { day: String(Number(day)), month: String(Number(month)), year }, status: v.status,
    followsControl: v.followsControl, evidence: v.evidence, uploading: [], noArtefact: v.closureNote !== null && v.evidence.length === 0,
    closureNote: v.closureNote ?? '', cancelReason: v.cancelReason ?? '', changeNote: '',
  };
}

/** `YYYY-MM-DD` from the three fields, or null unless they name a real calendar date (the server's `isCalendarDate`). */
export function dueDateOf(due: { day: string; month: string; year: string }): CalendarDate | null {
  if (!/^\d{1,2}$/.test(due.day) || !/^\d{1,2}$/.test(due.month) || !/^\d{4}$/.test(due.year)) return null;
  const [day, month, year] = [Number(due.day), Number(due.month), Number(due.year)];
  const iso = `${due.year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const real = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(real.getTime()) || real.toISOString().slice(0, 10) !== iso || year < 1 ? null : iso;
}

/**
 * The client mirror of FND-a's 422s for a mitigation (UX-16; texts of 7.4.2's S-15 row), in the order the server checks them.
 * `base` is the version being updated, or null for a new mitigation. A file still uploading is not an error here:
 * `saveGate` holds the save for it (UX-30).
 */
export function mitigationFormErrors(v: MitigationFormValue, base: MitigationVersionView | null): FieldError[] {
  const errors: FieldError[] = [];
  const text = (field: string, value: string, missing: string, max: number) => {
    const n = charCount(value);
    if (n === 0) errors.push({ field, message: missing });
    else if (n > max) errors.push({ field, message: tooLongText(n, max) });
  };
  text('what', v.what, FINDINGS_COPY.fields.what, TEXT_MAX);
  if (v.ownerUserId === '') errors.push({ field: 'ownerUserId', message: FINDINGS_COPY.fields.ownerUserId });
  const due = dueDateOf(v.due);
  if (due === null) errors.push({ field: 'dueDate', message: FINDINGS_COPY.fields.dueDate });
  if (v.status === 'done' && v.evidence.length === 0 && !(v.noArtefact && charCount(v.closureNote) > 0)) {
    errors.push({ field: 'closureNote', message: FINDINGS_COPY.fields.closureNote });
  } else if (v.status === 'done' && v.noArtefact && charCount(v.closureNote) > TEXT_MAX) {
    errors.push({ field: 'closureNote', message: tooLongText(charCount(v.closureNote), TEXT_MAX) });
  }
  if (v.status === 'cancelled') text('cancelReason', v.cancelReason, FINDINGS_COPY.fields.cancelReason, TEXT_MAX);
  if (base !== null && due !== null && due > base.dueDate) text('changeNote', v.changeNote, FINDINGS_COPY.fields.changeNote, CHANGE_NOTE_MAX);
  return errors;
}

export const CHANGE_NOTE_MAX = 1000;

/** UX-30: a file still uploading, or one that failed, holds the save; the person may save without it or cancel. */
export function saveGate(s: { uploading: readonly string[]; failed: readonly string[] }): { send: boolean; text: string | null; actions: string[] } {
  const waiting = [...s.uploading, ...s.failed];
  if (waiting.length === 0) return { send: true, text: null, actions: [] };
  return { send: false, text: FINDINGS_COPY.mitigationForm.waiting(waiting), actions: [FINDINGS_COPY.mitigationForm.saveWithout, FINDINGS_COPY.mitigationForm.cancel] };
}

/** UX-26: where the mitigation form's draft lives: the account, organisation, project, finding and mitigation (or "new"). */
export function mitigationDraftTarget(k: { userId: string; orgId: string; projectId: string; findingId: string; mitigationId: string | null }): DraftKey {
  return { userId: k.userId, orgId: k.orgId, projectId: k.projectId, target: { kind: 'mitigation', findingId: k.findingId, mitigationId: k.mitigationId } };
}

/** The storage key of that draft (`makrai.draft.v1:...:m:<finding>:<mitigation or new>`); the form writes and reads through `mitigationDraftTarget`, which this derives from. */
export function mitigationDraftKey(k: Parameters<typeof mitigationDraftTarget>[0]): string {
  return draftKey(mitigationDraftTarget(k));
}

/** A 409 `base_version_moved` body the view can read without a crash: the newer version's number, its author and its due date. */
export function isNewerVersion(v: unknown): v is MitigationVersionView {
  const o = v as Partial<MitigationVersionView> | null | undefined;
  return typeof o === 'object' && o !== null && typeof o.versionNumber === 'number' && typeof o.dueDate === 'string'
    && typeof o.enteredBy === 'object' && o.enteredBy !== null && typeof o.enteredBy.userId === 'string' && typeof o.enteredBy.name === 'string'
    && typeof o.owner === 'object' && o.owner !== null && typeof o.owner.name === 'string' && typeof o.receivedAt === 'string';
}

/** The shape of a stored form value (a draft written by another build or by hand is not trusted). */
export function isFormValue(v: unknown): v is MitigationFormValue {
  const o = v as Partial<MitigationFormValue> | null;
  const statuses: readonly unknown[] = ['planned', 'in_progress', 'done', 'cancelled'];
  return typeof o === 'object' && o !== null && typeof o.what === 'string' && typeof o.ownerUserId === 'string'
    && typeof o.due === 'object' && o.due !== null && typeof o.due.day === 'string' && typeof o.due.month === 'string' && typeof o.due.year === 'string'
    && statuses.includes(o.status) && Array.isArray(o.evidence) && Array.isArray(o.uploading)
    && typeof o.noArtefact === 'boolean' && typeof o.closureNote === 'string' && typeof o.cancelReason === 'string' && typeof o.changeNote === 'string';
}

export type RestoredDraft =
  | { kind: 'none' }
  | { kind: 'dropped' }
  | { kind: 'restored'; value: MitigationFormValue; retry: RetryState; savePressedAt: string | null; conflict: MitigationVersionView | null };

/**
 * UX-26: what the form finds in the browser when it opens. A draft that is not a form value is removed (`dropped`). A draft
 * started from another version than the current one comes back with `conflict` set to the current version, and the draft is
 * left as it is (its own base stays inside it until the person picks one of the three actions of 7.4.4).
 */
export function restoreMitigationDraft(store: DraftStore, key: DraftKey, now: Date, current: MitigationVersionView | null): RestoredDraft {
  const draft = store.read<unknown>(key, now);
  if (draft === null) return { kind: 'none' };
  if (!isFormValue(draft.value)) { store.remove(key); return { kind: 'dropped' }; }
  const moved = current !== null && draft.baseVersionNumber !== current.versionNumber;
  return { kind: 'restored', value: draft.value, retry: draft.retry, savePressedAt: draft.savePressedAt, conflict: moved ? current : null };
}

/**
 * UX-26: every change is written, except while a conflict is pending (SFH-1). The form's `base` is the current version then,
 * and writing it would replace the base the draft was started from, so the conflict would not show on the next visit and the
 * stale draft could be saved over the newer version without being reviewed.
 */
export function shouldWriteDraft(s: { restored: boolean; dirty: boolean; hasStore: boolean; conflictPending: boolean }): boolean {
  return s.restored && s.dirty && s.hasStore && !s.conflictPending;
}

export type ConflictChoice = 'save_mine' | 'edit_first' | 'discard';

/**
 * 7.4.4: what each of the three actions does. All move the form's base to the newer version. "Save mine" sends the draft on that
 * base (a new request id, because the body changed); "Edit mine first" keeps the draft and returns to the form; "Discard mine"
 * removes the draft and opens the form on the newer version. Nothing is merged.
 */
export function conflictAction(choice: ConflictChoice, newer: MitigationVersionView, mine: MitigationFormValue):
  { base: MitigationVersionView; value: MitigationFormValue; keepDraft: boolean; send: boolean } {
  if (choice === 'discard') return { base: newer, value: valueOf(newer), keepDraft: false, send: false };
  return { base: newer, value: mine, keepDraft: true, send: choice === 'save_mine' };
}

/** 7.4.2 S-15 row: "Saved as version N of this mitigation at <time>." The time is the device's (`formatTime`). */
export function mitigationSavedText(v: Pick<MitigationVersionView, 'versionNumber'>, timeText: string): string {
  return FINDINGS_COPY.mitigationForm.savedAs(v.versionNumber, timeText);
}

/**
 * Route 6's or 7's body (without `requestId`): the closure note only for Done with no artefact, the cancel reason only for Cancelled
 * (the server refuses either on another status), and, for an update, the version it starts from and its change note.
 */
export function mitigationRequestBody(v: MitigationFormValue, base: MitigationVersionView | null): Record<string, unknown> {
  const body: Record<string, unknown> = {
    what: v.what.trim(), ownerUserId: v.ownerUserId, dueDate: dueDateOf(v.due), status: v.status, followsControl: v.followsControl,
    closureNote: v.status === 'done' && v.noArtefact ? v.closureNote.trim() : null,
    cancelReason: v.status === 'cancelled' ? v.cancelReason.trim() : null,
    evidenceIds: v.evidence.map((e) => e.id),
  };
  if (base === null) return body;
  const dueDate = body.dueDate as CalendarDate | null;
  const later = dueDate !== null && dueDate > base.dueDate;
  return { ...body, baseVersionNumber: base.versionNumber, changeNote: later && charCount(v.changeNote) > 0 ? v.changeNote.trim() : null };
}

// ─── The accepted-risk form (S-15, W-6; FR-FND-05, UX-17) ───────────────────────────────────────

/** The client mirror of FND-a's 422s for an acceptance, in the server's order; a keep-accepted also needs its note. */
export function acceptRiskFormErrors(v: {
  acceptedBy: Decider | null; reason: string; lookAgain?: { day: string; month: string; year: string }; note?: string; requireNote?: boolean;
}): FieldError[] {
  const errors: FieldError[] = [];
  if (v.acceptedBy === null) errors.push({ field: 'acceptedBy', message: FINDINGS_COPY.fields.acceptedBy });
  const n = charCount(v.reason);
  if (n === 0) errors.push({ field: 'reason', message: FINDINGS_COPY.fields.acceptReason });
  else if (n > TEXT_MAX) errors.push({ field: 'reason', message: tooLongText(n, TEXT_MAX) });
  const l = v.lookAgain;
  if (l !== undefined && (l.day !== '' || l.month !== '' || l.year !== '') && dueDateOf(l) === null) {
    errors.push({ field: 'lookAgainOn', message: FINDINGS_COPY.fields.lookAgainOn });
  }
  if (v.requireNote === true && charCount(v.note ?? '') === 0) errors.push({ field: 'lookAgainNote', message: FINDINGS_COPY.fields.lookAgainNote });
  return errors;
}

/**
 * The accepter as the finding's label will name them: the person or the role alone (A3), exactly as `acceptedByName`
 * (lib/findings/labels.ts) prints it on the page. The form's option keeps "<Role> (no platform account)" (`outsideWho`).
 */
function whoText(choice: Decider, names: ReadonlyMap<string, string>): string {
  return choice.kind === 'member' ? names.get(choice.userId) ?? FINDINGS_COPY.acceptRisk.aMember : OUTSIDE_ROLE_LABELS[choice.role];
}

/** 7.4.2 S-15 row, with C#411's label: "Closed by an accepted risk (<who>)." */
export function acceptedSavedText(choice: Decider, names: ReadonlyMap<string, string>): string {
  return FINDINGS_COPY.acceptRisk.saved(whoText(choice, names));
}

/** UX-17, W-6: the label the finding will show, said before the button; none while nothing is chosen. */
export function acceptedLabelSentence(choice: Decider | null, names: ReadonlyMap<string, string>): string {
  return choice === null ? '' : FINDINGS_COPY.acceptRisk.willShow(whoText(choice, names));
}

// ─── Small rules the forms share ───────────────────────────────────────────────────────────────

/**
 * The sentence over an error summary: how many problems, and where the person's words are (`KEPT_ON_DEVICE` only when a
 * draft is kept). An acceptance's summary names "this form" (C#154).
 */
export function formSummary(what: 'mitigation' | 'finding' | 'acceptance', n: number, kept: string): string {
  return FINDINGS_COPY.summary(what === 'acceptance' ? 'form' : what, n, kept);
}

/** Route 5's body (without `requestId`): the texts trimmed and in NFC as the server digests them, so an edit of whitespace alone keeps the request id (UX-27). */
export function raiseRequestBody(v: RaiseFormValue, link: { stage: string; questionId: string; versionId: string | null } | null): Record<string, unknown> {
  const linked = link !== null && link.stage === v.stage;
  return {
    stage: v.stage, title: v.title.trim().normalize('NFC'), description: v.description.trim().normalize('NFC'), riskArea: v.riskArea === '' ? null : v.riskArea,
    questionId: linked ? link.questionId : null, decisionVersionId: linked ? link.versionId : null,
  };
}

/** The uploads that can hold a save: the evidence block exists only while the status is Done, and takes its uploads with it when it goes (UX-30). */
export function activeUpload(status: MitigationStatus, upload: { uploading: string[]; failed: string[] }): { uploading: string[]; failed: string[] } {
  return status === 'done' ? upload : { uploading: [], failed: [] };
}

/** The accepter as the label names them: a member's name, or the role alone (A3). A view wraps this in <bdi>. */
export function acceptedWho(choice: Decider, names: ReadonlyMap<string, string>): string {
  return whoText(choice, names);
}

/**
 * UX-26: the form's own draft write. Skips (returns `null`) when the form has not restored yet, has no edits, has no store, or has
 * a conflict pending (SFH-1: the draft keeps the base it was started from until one of the three actions of 7.4.4 is chosen).
 * Otherwise writes the draft with `base`'s number and answers whether the browser kept it.
 */
export function writeMitigationDraft(store: DraftStore | null, key: DraftKey, s: {
  restored: boolean; dirty: boolean; conflict: MitigationVersionView | null; base: MitigationVersionView | null; value: MitigationFormValue;
  upload: { uploading: string[]; failed: string[] }; savePressedAt: string | null; retry: RetryState; now: Date;
}): boolean | null {
  if (store === null || !shouldWriteDraft({ restored: s.restored, dirty: s.dirty, hasStore: true, conflictPending: s.conflict !== null })) return null;
  return store.write(key, {
    baseVersionNumber: s.base?.versionNumber ?? null, value: { ...s.value, uploading: [...s.upload.uploading, ...s.upload.failed] },
    savedAt: s.now.toISOString(), savePressedAt: s.savePressedAt, retry: s.retry,
  });
}
