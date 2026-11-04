import { ValidationFailed } from '@/lib/http/errors';
import { isRequestId } from '@/lib/data/idempotency';
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
 * digest nor a row (FR-ORG-09, FR-DEC-09). Every faulty field is named in one `ValidationFailed`, in body order.
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

/** The field texts (7.4.2 S-15 row, SRS line 2384, and the brief's request texts). */
export const FINDING_MESSAGES = Object.freeze({
  body: 'The request body must be a JSON object.',
  requestId: 'requestId must be a UUID (8-4-4-4-12 hexadecimal).',
  what: 'Write what will be done.',
  ownerUserId: 'Choose an owner.',
  dueDate: 'Enter a due date.',
  status: 'Choose a status.',
  followsControl: 'Choose a control from the suggested controls, or none.',
  closureNote: 'Add closure evidence, or say why there is none.',
  closureNoteNotDone: 'Only a done mitigation has a closure note.',
  cancelReason: 'Say why it is cancelled.',
  cancelReasonNotCancelled: 'Only a cancelled mitigation has a cancel reason.',
  evidenceIds: 'Attach each evidence item once, and at most 100.',
  baseVersionNumber: 'baseVersionNumber must be the number of the version you started from.',
  changeNote: 'Say why the date changed.',
  mode: 'mode must be accept or keep_accepted.',
  acceptedBy: 'Choose who accepted the risk.',
  acceptReason: 'Write why the risk is accepted.',
  lookAgainOn: 'Enter a real date to look at it again, or none.',
  lookAgainNote: 'Write what was looked at again.',
  eventReason: 'Write a reason.',
  eventCode: 'eventCode must be null: no event codes exist yet.',
  decisionVersionId: 'Choose the decision version that closes this finding.',
  cancelledFinal: 'A cancelled mitigation cannot be changed.',
  tooLong: (n: number, max: number) => `This is ${n.toLocaleString('en-GB')} characters. The limit is ${max.toLocaleString('en-GB')}.`,
  notStorable: 'This contains a character that cannot be stored. Remove it and save again.',
});

type Json = Record<string, unknown>;
type Check = (ok: boolean, field: string, message: string) => void;

const isString = (v: unknown): v is string => typeof v === 'string';
const STATUSES: readonly MitigationStatus[] = ['planned', 'in_progress', 'done', 'cancelled'];
const isStatus = (v: unknown): v is MitigationStatus => isString(v) && (STATUSES as readonly string[]).includes(v);
const isOutsideRole = (v: unknown): v is OutsideRole => isString(v) && (OUTSIDE_ROLES as readonly string[]).includes(v);
/** A lone UTF-16 surrogate cannot be carried by UTF-8; NUL cannot be stored in a PostgreSQL text column. */
const NOT_STORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

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

/** The fields an add and an update share, checked in body order. */
function mitigationFields(b: Json, c: ReturnType<typeof collector>): void {
  c.check(isRequestId(b.requestId), 'requestId', FINDING_MESSAGES.requestId);
  c.add(textError(b.what, 'what', FINDING_MESSAGES.what, TEXT_MAX));
  c.check(isString(b.ownerUserId) && b.ownerUserId !== '', 'ownerUserId', FINDING_MESSAGES.ownerUserId);
  c.check(isCalendarDate(b.dueDate), 'dueDate', FINDING_MESSAGES.dueDate);
  c.check(isStatus(b.status), 'status', FINDING_MESSAGES.status);
  c.check(b.followsControl === null || (isString(b.followsControl) && b.followsControl !== ''), 'followsControl', FINDING_MESSAGES.followsControl);
  const evidenceOk = Array.isArray(b.evidenceIds) && b.evidenceIds.every((id) => isString(id) && id !== '')
    && new Set(b.evidenceIds).size === b.evidenceIds.length && b.evidenceIds.length <= EVIDENCE_MAX;
  // FR-FND-04: done needs at least one evidence item or a written note of why no artefact exists.
  if (b.closureNote === null) {
    c.check(!(b.status === 'done' && evidenceOk && (b.evidenceIds as unknown[]).length === 0), 'closureNote', FINDING_MESSAGES.closureNote);
  } else if (b.status !== 'done') {
    c.check(false, 'closureNote', FINDING_MESSAGES.closureNoteNotDone);
  } else {
    c.add(textError(b.closureNote, 'closureNote', FINDING_MESSAGES.closureNote, TEXT_MAX));
  }
  // Cancelled is final and needs a reason (5.3 item 11, FR-FND-03).
  if (b.status === 'cancelled') c.add(textError(b.cancelReason, 'cancelReason', FINDING_MESSAGES.cancelReason, TEXT_MAX));
  else c.check(b.cancelReason === null, 'cancelReason', FINDING_MESSAGES.cancelReasonNotCancelled);
  c.check(evidenceOk, 'evidenceIds', FINDING_MESSAGES.evidenceIds);
}

function mitigationValue(b: Json): AddMitigationRequest {
  return {
    requestId: b.requestId as string, what: b.what as string, ownerUserId: b.ownerUserId as string, dueDate: b.dueDate as CalendarDate,
    status: b.status as MitigationStatus, followsControl: b.followsControl as string | null, closureNote: b.closureNote as string | null,
    cancelReason: b.cancelReason as string | null, evidenceIds: [...(b.evidenceIds as string[])],
  };
}

export function parseAddMitigation(body: unknown): AddMitigationRequest {
  const b = asObject(body);
  const c = collector();
  mitigationFields(b, c);
  if (c.errors.length > 0) throw new ValidationFailed(c.errors);
  return mitigationValue(b);
}

export function parseUpdateMitigation(body: unknown): UpdateMitigationRequest {
  const b = asObject(body);
  const c = collector();
  mitigationFields(b, c);
  c.check(Number.isSafeInteger(b.baseVersionNumber) && (b.baseVersionNumber as number) >= 1, 'baseVersionNumber', FINDING_MESSAGES.baseVersionNumber);
  // Required only when the due date moves later, which the service decides against the current version.
  if (b.changeNote !== null) c.add(textError(b.changeNote, 'changeNote', FINDING_MESSAGES.changeNote, CHANGE_NOTE_MAX));
  if (c.errors.length > 0) throw new ValidationFailed(c.errors);
  return { ...mitigationValue(b), baseVersionNumber: b.baseVersionNumber as number, changeNote: b.changeNote as string | null };
}

function isDecider(v: unknown): v is Decider {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const d = v as Json;
  return (d.kind === 'member' && isString(d.userId) && d.userId !== '') || (d.kind === 'outside_role' && isOutsideRole(d.role));
}

export function parseAcceptRisk(body: unknown): AcceptRiskRequest {
  const b = asObject(body);
  const c = collector();
  c.check(isRequestId(b.requestId), 'requestId', FINDING_MESSAGES.requestId);
  c.check(b.mode === 'accept' || b.mode === 'keep_accepted', 'mode', FINDING_MESSAGES.mode);
  c.check(isDecider(b.acceptedBy), 'acceptedBy', FINDING_MESSAGES.acceptedBy);
  c.add(textError(b.reason, 'reason', FINDING_MESSAGES.acceptReason, TEXT_MAX));
  c.check(b.lookAgainOn === null || isCalendarDate(b.lookAgainOn), 'lookAgainOn', FINDING_MESSAGES.lookAgainOn);
  // "Looked at again: keep accepted" is a new accepted risk with a note (FR-FND-05); a first acceptance may carry one.
  if (b.mode === 'keep_accepted' || b.lookAgainNote !== null) {
    c.add(textError(b.lookAgainNote, 'lookAgainNote', FINDING_MESSAGES.lookAgainNote, TEXT_MAX));
  }
  if (c.errors.length > 0) throw new ValidationFailed(c.errors);
  const d = b.acceptedBy as Decider;
  return {
    requestId: b.requestId as string, mode: b.mode as AcceptRiskRequest['mode'],
    acceptedBy: d.kind === 'member' ? { kind: 'member', userId: d.userId } : { kind: 'outside_role', role: d.role },
    reason: b.reason as string, lookAgainOn: b.lookAgainOn as CalendarDate | null, lookAgainNote: b.lookAgainNote as string | null,
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
  return { requestId: b.requestId as string, reason: b.reason as string, eventCode: null };
}

export function parseCloseByDecision(body: unknown): CloseByDecisionRequest {
  const b = asObject(body);
  const c = collector();
  c.check(isRequestId(b.requestId), 'requestId', FINDING_MESSAGES.requestId);
  c.check(isString(b.decisionVersionId) && b.decisionVersionId !== '', 'decisionVersionId', FINDING_MESSAGES.decisionVersionId);
  if (c.errors.length > 0) throw new ValidationFailed(c.errors);
  return { requestId: b.requestId as string, decisionVersionId: b.decisionVersionId as string };
}
