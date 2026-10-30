import {
  OUTSIDE_ROLES, type CalendarDate, type Decider, type DecisionStatus, type DeclaredDate, type DeclaredPrecision, type FieldError,
  type ScopeAnswer,
} from '@/types/record';
import type { QuestionType, ReasonCodeEntry } from '@/types/content';
import { daysInMonth, M11, REQUEST_MESSAGES } from './copy';

/**
 * The field rules of a decision (FR-DEC-01, FR-DEC-02, UX-10, UX-12, M-11), shared by the decision service
 * and the S-12 form so the server and the browser refuse the same input with the same text. The texts come
 * from `./copy`, which imports only `types/`; nothing here reads the database, the clock or the content, so
 * a client component can import it. What only the server can check (the question is in the running content,
 * the decider is or was a member, the evidence is of this project) is `lib/data/decisions.ts`'s.
 */

export const REASON_MAX = 4000;

export type DateParts = { day: string; month: string; year: string };

/** The four statuses a save may carry, and the three scope answers (types/record.ts; the parser reads these too). */
export const STATUSES: readonly DecisionStatus[] = ['done', 'partly', 'not_yet', 'not_applicable'];
export const SCOPES: readonly ScopeAnswer[] = ['yes', 'no', 'not_sure'];

const pad2 = (n: number) => String(n).padStart(2, '0');
const dateError = (message: string): FieldError => ({ field: 'declaredDate', message });

/**
 * UX-10: three fields to a declared date at its precision. An empty day means month precision; an empty
 * day and month mean year precision. A missing year, a day without a month, a month outside 1 to 12, a year
 * that is not four digits and a day the month does not have are refused with their M-11 text. Whether the
 * date is later than today is `validateDecisionFields`'s, which knows today.
 */
export function declaredDateFromParts(p: DateParts): { date: DeclaredDate; precision: DeclaredPrecision } | FieldError {
  const day = p.day.trim();
  const month = p.month.trim();
  const year = p.year.trim();
  if (year === '') return dateError(M11.yearMissing);
  // Four digits, from 0001: PostgreSQL's DATE has no year 0, and JavaScript reads 0000 as 1 BC.
  if (!/^\d{4}$/.test(year) || year === '0000') return dateError(M11.yearFormat);
  if (month === '') return day === '' ? { date: year, precision: 'year' } : dateError(M11.dayWithoutMonth);
  const m = /^\d{1,2}$/.test(month) ? Number(month) : NaN;
  if (!(m >= 1 && m <= 12)) return dateError(M11.monthRange);
  if (day === '') return { date: `${year}-${pad2(m)}`, precision: 'month' };
  const y = Number(year);
  const d = /^\d{1,2}$/.test(day) ? Number(day) : NaN;
  if (!(d >= 1 && d <= daysInMonth(m, y))) return dateError(M11.monthDays(m, y));
  return { date: `${year}-${pad2(m)}-${pad2(d)}`, precision: 'day' };
}

/**
 * FR-DEC-02: the latest declared date accepted is the calendar date of `now` in UTC+14, so nobody is refused
 * for today's date in any time zone. The server passes the database's clock, the form the device's.
 */
export function utcPlus14Date(now: Date): CalendarDate {
  return new Date(now.getTime() + 14 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The reason's length in Unicode code points, the unit of the 4,000 limit (an emoji counts once). */
export function reasonLength(reason: string): number {
  return Array.from(reason).length;
}

/** A lone UTF-16 surrogate: UTF-8 cannot carry it, so it would be stored as U+FFFD, not as typed. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The reason rule of a decision and of a withdrawal (FR-DEC-01, FR-DEC-08): 1 to 4,000 code points that are
 * not all white space, and no character PostgreSQL cannot store unchanged (U+0000 is refused in `text` with
 * SQLSTATE 22021; a lone surrogate would be replaced). Not a contract symbol: the withdrawal checks share it.
 */
export function reasonFieldError(reason: string): FieldError | null {
  if (reason.trim() === '') return { field: 'reason', message: M11.reasonMissing };
  const n = reasonLength(reason);
  if (n > REASON_MAX) return { field: 'reason', message: M11.reasonTooLong(n) };
  if (reason.includes('\u0000') || LONE_SURROGATE.test(reason)) return { field: 'reason', message: M11.reasonNul };
  return null;
}

export interface DecisionFieldsInput {
  questionType: QuestionType; options: readonly string[]; reasonCodes: readonly ReasonCodeEntry[];
  status: DecisionStatus | null; scopeAnswer: ScopeAnswer | null; optionsInPlace: readonly string[];
  reasonCode: string | null; reason: string; decidedBy: Decider | null; declaredDate: DeclaredDate | null;
}

function deciderError(d: Decider | null): FieldError | null {
  const ok = d !== null && (
    (d.kind === 'member' && typeof d.userId === 'string' && d.userId !== '')
    || (d.kind === 'outside_role' && OUTSIDE_ROLES.includes(d.role)));
  return ok ? null : { field: 'decidedBy', message: M11.decidedBy };
}

/** A stored declared date: 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD', a real date, not later than `latest`. */
function declaredDateError(date: DeclaredDate | null, latest: CalendarDate): FieldError | null {
  if (date === null) return dateError(M11.yearMissing);
  const parts = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(date);
  if (parts === null || parts[1] === '0000') return dateError(M11.yearFormat);
  const [, year, month, day] = parts;
  if (month !== undefined && !(Number(month) >= 1 && Number(month) <= 12)) return dateError(M11.monthRange);
  if (day !== undefined && !(Number(day) >= 1 && Number(day) <= daysInMonth(Number(month), Number(year)))) {
    return dateError(M11.monthDays(Number(month), Number(year)));
  }
  // The earliest day the date names: a month or a year that has begun by `latest` is not later than today.
  const earliest = `${year}-${month ?? '01'}-${day ?? '01'}`;
  return earliest > latest ? dateError(M11.dateLater) : null;
}

/**
 * Every field rule FR-DEC-01 and FR-DEC-02 fix that needs no database: at most one error per field, in the
 * order status or scope answer, options in place, reason code, reason, decided by, declared date. Field names
 * are `SaveDecisionRequest` keys, so the form maps a server error and its own to the same field.
 */
export function validateDecisionFields(i: DecisionFieldsInput, latest: CalendarDate): FieldError[] {
  const errors: FieldError[] = [];
  const gate = i.questionType === 'gate';

  if (gate) {
    if (i.status !== null) errors.push({ field: 'status', message: REQUEST_MESSAGES.statusOnScope });
    if (i.scopeAnswer === null || !SCOPES.includes(i.scopeAnswer)) errors.push({ field: 'scopeAnswer', message: M11.scopeAnswer });
  } else {
    if (i.status === null || !STATUSES.includes(i.status)) errors.push({ field: 'status', message: M11.status });
    if (i.scopeAnswer !== null) errors.push({ field: 'scopeAnswer', message: REQUEST_MESSAGES.scopeOnPractice });
  }

  if (i.questionType !== 'checklist') {
    if (i.optionsInPlace.length > 0) errors.push({ field: 'optionsInPlace', message: REQUEST_MESSAGES.optionsOnPractice });
  } else if (i.optionsInPlace.length > i.options.length
    || new Set(i.optionsInPlace).size !== i.optionsInPlace.length || i.optionsInPlace.some((o) => !i.options.includes(o))) {
    errors.push({ field: 'optionsInPlace', message: REQUEST_MESSAGES.optionsNotOfQuestion });
  }

  // OD-C2 (a): required with not applicable and not yet, from that status's list; refused with any other status.
  // With no valid status on a practice question the status error stands alone: no code can be judged against it.
  const status = !gate && i.status !== null && STATUSES.includes(i.status) ? i.status : null;
  if (status === 'not_yet' || status === 'not_applicable') {
    if (i.reasonCode === null) errors.push({ field: 'reasonCode', message: M11.reasonCode });
    else if (!i.reasonCodes.some((c) => c.code === i.reasonCode && c.status === status)) {
      errors.push({ field: 'reasonCode', message: M11.reasonCodeNotAllowed });
    }
  } else if (i.reasonCode !== null && (gate || status !== null)) {
    errors.push({ field: 'reasonCode', message: M11.reasonCodeNotAllowed });
  }

  const reason = reasonFieldError(i.reason);
  if (reason) errors.push(reason);
  const decider = deciderError(i.decidedBy);
  if (decider) errors.push(decider);
  const date = declaredDateError(i.declaredDate, latest);
  if (date) errors.push(date);
  return errors;
}
