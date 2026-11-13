import type { DateParts } from '@/components/ui/types';
import { daysInMonth } from '@/lib/decision/copy';
import type { CalendarDate } from '@/types/record';

/**
 * A calendar date and DateField's three boxes, both ways (plan 1A Task 4). Pure, so 1B and 1C check the boxes the way
 * the component shows them. The boxes carry no leading zeros; the date is 'YYYY-MM-DD'.
 */

/** The parse result: a calendar date or no date, or why the boxes are not one. */
export type DatePartsResult = { ok: true; value: CalendarDate | null } | { ok: false; error: 'incomplete' | 'not_a_date' };

/**
 * A calendar date as the three boxes; null gives three empty boxes (DateField is never pre-filled by itself), and so
 * does the empty string, which is how a form that held a native date input keeps "no date"
 * (components/project/ProjectForm.tsx). A date given only to the month or the year ('2026-02', '2026', as a declared
 * date is stored) leaves the missing boxes empty. Any other string, a blank one of spaces included, throws a RangeError
 * naming it, as lib/format/dates.ts does: a wrong value is never shown as a date.
 */
export function datePartsOf(d: CalendarDate | null): DateParts {
  if (d === null || d === '') return { day: '', month: '', year: '' };
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(d);
  if (m === null) throw new RangeError(`not a calendar date: ${JSON.stringify(d)}`);
  const [, year, month, day] = m;
  const box = (part: string | undefined) => (part === undefined ? '' : String(Number(part)));
  return { day: box(day), month: box(month), year };
}

/** Today's date on this device, in the reader's own zone, as the three boxes (DateField's "Today"). */
export function todayParts(now: Date): DateParts {
  return { day: String(now.getDate()), month: String(now.getMonth() + 1), year: String(now.getFullYear()) };
}

/**
 * The three boxes as a calendar date. All empty: no date. Some empty: 'incomplete'. A box that is not whole digits, a
 * year that is not four digits from 0001 (PostgreSQL's DATE has no year 0, as lib/decision/rules.ts refuses it too), or a
 * day or month the calendar does not have (31 February): 'not_a_date'. Spaces around a box are ignored.
 */
export function parseDateParts(p: DateParts): DatePartsResult {
  const day = p.day.trim();
  const month = p.month.trim();
  const year = p.year.trim();
  const filled = [day, month, year].filter((s) => s !== '').length;
  if (filled === 0) return { ok: true, value: null };
  if (filled < 3) return { ok: false, error: 'incomplete' };
  if (!/^\d{1,2}$/.test(day) || !/^\d{1,2}$/.test(month) || !/^\d{4}$/.test(year) || year === '0000') return { ok: false, error: 'not_a_date' };
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(m, y)) return { ok: false, error: 'not_a_date' };
  return { ok: true, value: `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}
