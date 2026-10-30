import { ValidationFailed } from '@/lib/http/errors';
import { isRequestId } from '@/lib/data/idempotency';
import { REQUEST_MESSAGES, M11 } from '@/lib/decision/copy';
import { reasonFieldError } from '@/lib/decision/rules';
import { STAGES, type Decider, type DecisionStatus, type FieldError, type ReasonCode, type ScopeAnswer, type Stage, type WithdrawalCode } from '@/types/record';
import type { SaveDecisionRequest, WithdrawDecisionRequest } from '@/types/api';

/**
 * The shape check of the two decision request bodies (contract Routes rows 1 and 2), server only. A route
 * runs it on `await req.json()` before anything else reads the body, and digests what it returns, so a body
 * that is not an object, a number that is not an integer (which `requestDigest` would throw on, contract
 * K0a row) or a field of the wrong type answers 422 naming the field instead of 500 (obligation D10).
 *
 * It checks types only; what the values mean (the question, the reason code, the decider) is checked by the
 * service against the running content and the organisation. It returns a new object holding exactly the
 * request's own keys, so an unknown key the client sends (`enteredById`, `receivedAt`) reaches neither the
 * digest nor the row (FR-DEC-09). Every faulty field is named in one `ValidationFailed`.
 */

type Json = Record<string, unknown>;

function asObject(json: unknown): Json {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new ValidationFailed([{ field: 'body', message: REQUEST_MESSAGES.body }]);
  }
  return json as Json;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isPositiveInteger = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
const oneOf = <T extends string>(list: readonly T[]) => (v: unknown): v is T => isString(v) && (list as readonly string[]).includes(v);

const isStage = oneOf<Stage>(STAGES);
const isStatus = oneOf<DecisionStatus>(['done', 'partly', 'not_yet', 'not_applicable']);
const isScope = oneOf<ScopeAnswer>(['yes', 'no', 'not_sure']);
const isWithdrawalCode = oneOf<WithdrawalCode>(['entered_in_error', 'wrong_project', 'duplicate', 'test_entry']);

function isDecider(v: unknown): v is Decider {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const d = v as Json;
  return (d.kind === 'member' && isString(d.userId)) || (d.kind === 'outside_role' && isString(d.role));
}

/** Copies a decider holding only its own keys. */
function decider(d: Decider): Decider {
  return d.kind === 'member' ? { kind: 'member', userId: d.userId } : { kind: 'outside_role', role: d.role };
}

export function parseSaveDecisionRequest(json: unknown): SaveDecisionRequest {
  const b = asObject(json);
  const errors: FieldError[] = [];
  const check = (ok: boolean, field: string, message: string) => { if (!ok) errors.push({ field, message }); };
  check(isRequestId(b.requestId), 'requestId', REQUEST_MESSAGES.requestId);
  check(isStage(b.stage), 'stage', REQUEST_MESSAGES.stage);
  check(isString(b.questionId) && b.questionId !== '', 'questionId', REQUEST_MESSAGES.questionId);
  check(b.baseVersionNumber === null || isPositiveInteger(b.baseVersionNumber), 'baseVersionNumber', REQUEST_MESSAGES.baseVersionNumber);
  check(b.status === null || isStatus(b.status), 'status', M11.status);
  check(b.scopeAnswer === null || isScope(b.scopeAnswer), 'scopeAnswer', M11.scopeAnswer);
  check(isStringArray(b.optionsInPlace), 'optionsInPlace', REQUEST_MESSAGES.optionsNotOfQuestion);
  check(b.reasonCode === null || isString(b.reasonCode), 'reasonCode', M11.reasonCodeNotAllowed);
  check(isString(b.reason), 'reason', M11.reasonMissing);
  check(isDecider(b.decidedBy), 'decidedBy', M11.decidedBy);
  check(isString(b.declaredDate), 'declaredDate', M11.yearMissing);
  check(isStringArray(b.evidenceIds), 'evidenceIds', REQUEST_MESSAGES.evidenceIds);
  if (errors.length > 0) throw new ValidationFailed(errors);
  return {
    requestId: b.requestId as string, stage: b.stage as Stage, questionId: b.questionId as string,
    baseVersionNumber: b.baseVersionNumber as number | null, status: b.status as DecisionStatus | null,
    scopeAnswer: b.scopeAnswer as ScopeAnswer | null, optionsInPlace: [...(b.optionsInPlace as string[])],
    // A code outside the content's list is refused by the service with the field's message (FR-DEC-02).
    reasonCode: b.reasonCode as ReasonCode | null, reason: b.reason as string, decidedBy: decider(b.decidedBy as Decider),
    declaredDate: b.declaredDate as string, evidenceIds: [...(b.evidenceIds as string[])],
  };
}

/**
 * The field rules of a withdrawal (FR-DEC-08): a withdrawal code of the fixed list and a reason by the rule of
 * a decision's reason. `withdrawDecision` runs the same check, so a direct service call is refused the same way.
 */
export function withdrawalFieldErrors(a: { withdrawalCode?: unknown; reason?: unknown }): FieldError[] {
  const errors: FieldError[] = [];
  if (!isWithdrawalCode(a.withdrawalCode)) errors.push({ field: 'withdrawalCode', message: REQUEST_MESSAGES.withdrawalCode });
  const reason = isString(a.reason) ? reasonFieldError(a.reason) : { field: 'reason', message: M11.reasonMissing };
  if (reason) errors.push(reason);
  return errors;
}

export function parseWithdrawDecisionRequest(json: unknown): WithdrawDecisionRequest {
  const b = asObject(json);
  const errors: FieldError[] = [];
  if (!isRequestId(b.requestId)) errors.push({ field: 'requestId', message: REQUEST_MESSAGES.requestId });
  if (!isStage(b.stage)) errors.push({ field: 'stage', message: REQUEST_MESSAGES.stage });
  if (!isPositiveInteger(b.baseVersionNumber)) errors.push({ field: 'baseVersionNumber', message: REQUEST_MESSAGES.noCurrentDecision });
  errors.push(...withdrawalFieldErrors(b));
  if (errors.length > 0) throw new ValidationFailed(errors);
  return {
    requestId: b.requestId as string, stage: b.stage as Stage, baseVersionNumber: b.baseVersionNumber as number,
    withdrawalCode: b.withdrawalCode as WithdrawalCode, reason: b.reason as string,
  };
}
