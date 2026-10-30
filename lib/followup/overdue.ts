import type { CalendarDate, FindingState, MitigationStatus } from '@/types/record';

const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * The calendar date at `now` in UTC+3 (East Africa Time, which has no daylight saving). A mitigation
 * due on a date turns overdue when this date is later than it, that is at 21:00 UTC on the due date.
 * Throws a RangeError for an invalid Date.
 */
export function eatDate(now: Date): CalendarDate {
  return new Date(now.getTime() + EAT_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * A mitigation is overdue when it is planned or in progress, its finding is open and its due date is
 * earlier than `today` (FR-FUP-02). `CalendarDate`s are `YYYY-MM-DD`, so string order is date order.
 */
export function isOverdue(
  m: { status: MitigationStatus; dueDate: CalendarDate },
  findingState: FindingState,
  today: CalendarDate,
): boolean {
  if (findingState !== 'open') return false;
  if (m.status !== 'planned' && m.status !== 'in_progress') return false;
  return m.dueDate < today;
}
