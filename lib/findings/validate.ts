import { ValidationFailed } from '@/lib/http/errors';
import { isRequestId } from '@/lib/data/idempotency';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { HTTP_COPY } from '@/lib/http/copy';
import { OUTSIDE_ROLES, type CalendarDate, type Decider, type FieldError, type MitigationStatus, type OutsideRole } from '@/types/record';
import type {
  AcceptRiskRequest, AddMitigationRequest, CloseByDecisionRequest, FindingEventRequest, UpdateMitigationRequest,
} from '@/types/api';

/**
 * The shape and length check of the five finding request bodies (contract Routes rows 6 to 11). Routes run it on
 * what `readJsonBody` read and digest what it returns; the services run it again on what they are given, so a
 * direct call is refused the same way. The rules that need the database (the owner, the evidence, the state, the
 * base version, the due date against the current one) are the services'. Each parser returns a new object of
 * exactly the request type's keys, so a body field such as `enteredById` or `receivedAt` reaches neither the
 * digest nor a row (FR-ORG-09, FR-DEC-09). Every text is returned trimmed and in NFC, the form its length was checked in. Every faulty field is named in one `ValidationFailed`, in body order.
 */

/** FR-DEC-01's limit, read for every finding text (owner question B14; W-6 "96 / 4,000 characters", SRS line 2030). */
export const TEXT_MAX = 4000;
/** FR-FND-03: the change note is 1 to 1,000 characters. */
export const CHANGE_NOTE_MAX = 1000;
/** The most evidence items one mitigation version attaches: a bound before the service queries the ids (as decisions, lib/decision/parse.ts). */
const EVIDENCE_MAX = 100;

/** Code points of the trimmed text after Unicode NFC (FR-REV-01's rule, SRS line 969): an emoji counts once. */
export function textLength(s: string): number {
  return Array.from(s.trim().normalize('NFC')).length;
}

/**
 * The field texts (7.4.2 S-15 row, SRS line 2384, and the brief's request texts). Every text a form may show is
 * `FINDINGS_COPY.fields`' own string, the copy the forms' checks and `fieldText`'s allow-list read too; the texts that
 * name a request field (`body`, `requestId`, `baseVersionNumber`, `mode`, `eventCode`, `notText`) are for a developer and
 * a form shows its fixed sentence in their place.
 */
const F = FINDINGS_COPY.fields;
export const FINDING_MESSAGES = Object.freeze({
  // E12, E14 (E-API-17, E-API-19): the words every route gives a body that is not a JSON object and a request id that is
  // not a UUID. A form never shows them (`fieldText` shows its fixed sentence), so a person meets them only through a broken page.
  body: HTTP_COPY.unreadable,
  requestId: HTTP_COPY.outOfDate,
  what: F.what,
  ownerUserId: F.ownerUserId,
  dueDate: F.dueDate,
  status: F.status,
  followsControl: F.followsControl,
  closureNote: F.closureNote,
  closureNoteNotDone: F.closureNoteNotDone,
  cancelReason: F.cancelReason,
  cancelReasonNotCancelled: F.cancelReasonNotCancelled,
  evidenceIds: F.evidenceIds,
  baseVersionNumber: 'baseVersionNumber must be the number of the version you started from.',
  changeNote: F.changeNote,
  mode: 'mode must be accept or keep_accepted.',
  acceptedBy: F.acceptedBy,
  acceptReason: F.acceptReason,
  lookAgainOn: F.lookAgainOn,
  lookAgainNote: F.lookAgainNote,
  eventReason: F.eventReason,
  eventCode: 'eventCode must be null: no event codes exist yet.',
  decisionVersionId: F.closingDecisionVersionId,
  cancelledFinal: F.cancelledFinal,
  tooLong: FINDINGS_COPY.tooLong,
  notStorable: F.notStorable,
  notText: (field: string) => `${field} must be text or null.`,
});

type Json = Record<string, unknown>;
type Check = (ok: boolean, field: string, message: string) => void;

const isString = (v: unknown): v is string => typeof v === 'string';
const STATUSES: readonly MitigationStatus[] = ['planned', 'in_progress', 'done', 'cancelled'];
const isStatus = (v: unknown): v is MitigationStatus => isString(v) && (STATUSES as readonly string[]).includes(v);
const isOutsideRole = (v: unknown): v is OutsideRole => isString(v) && (OUTSIDE_ROLES as readonly string[]).includes(v);
/** A lone UTF-16 surrogate cannot be carried by UTF-8; NUL cannot be stored in a PostgreSQL text column. */
export const NOT_STORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The text as stored: trimmed and in NFC, exactly what `textLength` measured (so padding cannot carry a text past its limit). */
const clean = (s: string): string => s.trim().normalize('NFC');
/** A body id: a non-empty string the database can store (NUL or a lone surrogate would fail the query, not answer 422). */
const isId = (v: unknown): v is string => isString(v) && v !== '' && !NOT_STORABLE.test(v);

/** A real `YYYY-MM-DD` calendar date (2026-02-30 is not one). */
export function isCalendarDate(v: unknown): v is CalendarDate {
  if (!isString(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= '0001-01-01';
}

function asObject(json: unknown): Json {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new ValidationFailed([{ field: 'body', message: FINDING_MESSAGES.body }]);
  }
  return json as Json;
}

/** The error of a required text, or null: a string, not blank, within `max`, storable. */
function textError(v: unknown, field: string, missing: string, max: number): FieldError | null {
  if (!isString(v) || textLength(v) === 0) return { field, message: missing };
  const n = textLength(v);
  if (n > max) return { field, message: FINDING_MESSAGES.tooLong(n, max) };
  if (NOT_STORABLE.test(v)) return { field, message: FINDING_MESSAGES.notStorable };
  return null;
}

function collector(): { errors: FieldError[]; check: Check; add: (e: FieldError | null) => void } {
  const errors: FieldError[] = [];
  return {
    errors,
    check: (ok, field, message) => { if (!ok) errors.push({ field, message }); },
    add: (e) => { if (e) errors.push(e); },
  };
}

/**
 * An optional note: null, or text. A blank string reads as none (a form sends "" for an empty box), so the rule that
 * needs the note (done, cancelled, a later date) answers with its own text; a missing key or a value that is not text
 * is named as such.
 */
function optionalNote(b: Json, field: string, c: ReturnType<typeof collector>): string | null {
  const v = b[field];
  if (v === null) return null;
  if (!isString(v)) {
    c.check(false, field, FINDING_MESSAGES.notText(field));
    return null;
  }
  return textLength(v) === 0 ? null : clean(v);
}

/** The fields an add and an update share, checked in body order; returns the optional notes as read. */
function mitigationFields(b: Json, c: ReturnType<typeof collector>): { closureNote: string | null; cancelReason: string | null } {
  c.check(isRequestId(b.requestId), 'requestId', FINDING_MESSAGES.requestId);
  c.add(textError(b.what, 'what', FINDING_MESSAGES.what, TEXT_MAX));
  c.check(isId(b.ownerUserId), 'ownerUserId', FINDING_MESSAGES.ownerUserId);
  c.check(isCalendarDate(b.dueDate), 'dueDate', FINDING_MESSAGES.dueDate);
  c.check(isStatus(b.status), 'status', FINDING_MESSAGES.status);
  c.check(b.followsControl === null || (isString(b.followsControl) && b.followsControl !== ''), 'followsControl', FINDING_MESSAGES.followsControl);
  const evidenceOk = Array.isArray(b.evidenceIds) && b.evidenceIds.every(isId)
    && new Set(b.evidenceIds).size === b.evidenceIds.length && b.evidenceIds.length <= EVIDENCE_MAX;
  const errorsBefore = c.errors.length;
  const closureNote = optionalNote(b, 'closureNote', c);
  // FR-FND-04: done needs at least one evidence item or a written note of why no artefact exists.
  if (c.errors.length === errorsBefore) {
    if (closureNote === null) {
      c.check(!(b.status === 'done' && evidenceOk && (b.evidenceIds as unknown[]).length === 0), 'closureNote', FINDING_MESSAGES.closureNote);
    } else if (b.status !== 'done') {
      c.check(false, 'closureNote', FINDING_MESSAGES.closureNoteNotDone);
    } else {
      c.add(textError(closureNote, 'closureNote', FINDING_MESSAGES.closureNote, TEXT_MAX));
    }
  }
  const beforeCancel = c.errors.length;
  const cancelReason = optionalNote(b, 'cancelReason', c);
  // Cancelled is final and needs a reason (5.3 item 11, FR-FND-03).
  if (c.errors.length === beforeCancel) {
    if (b.status === 'cancelled') c.add(textError(cancelReason, 'cancelReason', FINDING_MESSAGES.cancelReason, TEXT_MAX));
    else c.check(cancelReason === null, 'cancelReason', FINDING_MESSAGES.cancelReasonNotCancelled);
  }
  c.check(evidenceOk, 'evidenceIds', FINDING_MESSAGES.evidenceIds);
  return { closureNote, cancelReason };
}

function mitigationValue(b: Json, notes: { closureNote: string | null; cancelReason: string | null }): AddMitigationRequest {
  return {
    requestId: b.requestId as string, what: clean(b.what as string), ownerUserId: b.ownerUserId as string, dueDate: b.dueDate as CalendarDate,
    status: b.status as MitigationStatus, followsControl: b.followsControl as string | null, closureNote: notes.closureNote,
    cancelReason: notes.cancelReason, evidenceIds: [...(b.evidenceIds as string[])],
  };
}

export function parseAddMitigation(body: unknown): AddMitigationRequest {
  const b = asObject(body);
  const c = collector();
  const notes = mitigationFields(b, c);
  if (c.errors.length > 0) throw new ValidationFailed(c.errors);
  return mitigationValue(b, notes);
}

export function parseUpdateMitigation(body: unknown): UpdateMitigationRequest {
  const b = asObject(body);
  const c = collector();
  const notes = mitigationFields(b, c);
  c.check(Number.isSafeInteger(b.baseVersionNumber) && (b.baseVersionNumber as number) >= 1, 'baseVersionNumber', FINDING_MESSAGES.baseVersionNumber);
  // Required only when the due date moves later, which the service decides against the current version.
  const changeNote = optionalNote(b, 'changeNote', c);
  if (changeNote !== null) c.add(textError(changeNote, 'changeNote', FINDING_MESSAGES.changeNote, CHANGE_NOTE_MAX));
  if (c.errors.length > 0) throw new ValidationFailed(c.errors);
  return { ...mitigationValue(b, notes), baseVersionNumber: b.baseVersionNumber as number, changeNote };
}

function isDecider(v: unknown): v is Decider {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const d = v as Json;
  return (d.kind === 'member' && isId(d.userId)) || (d.kind === 'outside_role' && isOutsideRole(d.role));
}

export function parseAcceptRisk(body: unknown): AcceptRiskRequest {
  const b = asObject(body);
  const c = collector();
  c.check(isRequestId(b.requestId), 'requestId', FINDING_MESSAGES.requestId);
  c.check(b.mode === 'accept' || b.mode === 'keep_accepted', 'mode', FINDING_MESSAGES.mode);
  c.check(isDecider(b.acceptedBy), 'acceptedBy', FINDING_MESSAGES.acceptedBy);
  c.add(textError(b.reason, 'reason', FINDING_MESSAGES.acceptReason, TEXT_MAX));
  c.check(b.lookAgainOn === null || isCalendarDate(b.lookAgainOn), 'lookAgainOn', FINDING_MESSAGES.lookAgainOn);
  // "Keep the risk accepted" is a new accepted risk with a note (FR-FND-05); a first acceptance may carry one.
  const before = c.errors.length;
  const lookAgainNote = optionalNote(b, 'lookAgainNote', c);
  if (c.errors.length === before && (b.mode === 'keep_accepted' || lookAgainNote !== null)) {
    c.add(textError(lookAgainNote, 'lookAgainNote', FINDING_MESSAGES.lookAgainNote, TEXT_MAX));
  }
  if (c.errors.length > 0) throw new ValidationFailed(c.errors);
  const d = b.acceptedBy as Decider;
  return {
    requestId: b.requestId as string, mode: b.mode as AcceptRiskRequest['mode'],
    acceptedBy: d.kind === 'member' ? { kind: 'member', userId: d.userId } : { kind: 'outside_role', role: d.role },
    reason: clean(b.reason as string), lookAgainOn: b.lookAgainOn as CalendarDate | null, lookAgainNote,
  };
}

export function parseFindingEvent(body: unknown): FindingEventRequest {
  const b = asObject(body);
  const c = collector();
  c.check(isRequestId(b.requestId), 'requestId', FINDING_MESSAGES.requestId);
  c.add(textError(b.reason, 'reason', FINDING_MESSAGES.eventReason, TEXT_MAX));
  // Owner question B15: the SRS names an event code (line 1214) and defines no set, so v1 takes none.
  c.check(b.eventCode === null, 'eventCode', FINDING_MESSAGES.eventCode);
  if (c.errors.length > 0) throw new ValidationFailed(c.errors);
  return { requestId: b.requestId as string, reason: clean(b.reason as string), eventCode: null };
}

export function parseCloseByDecision(body: unknown): CloseByDecisionRequest {
  const b = asObject(body);
  const c = collector();
  c.check(isRequestId(b.requestId), 'requestId', FINDING_MESSAGES.requestId);
  c.check(isId(b.decisionVersionId), 'decisionVersionId', FINDING_MESSAGES.decisionVersionId);
  if (c.errors.length > 0) throw new ValidationFailed(c.errors);
  return { requestId: b.requestId as string, decisionVersionId: b.decisionVersionId as string };
}
