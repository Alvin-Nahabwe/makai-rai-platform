import type { CalendarDate, DeclaredDate, UtcInstant } from '@/types/record';

/**
 * Dates and times as 7.5.8 writes them (SRS lines 2585-2593): a day is "2 Nov 2026", a time is "10:42 EAT".
 * The month names are this fixed list and never `Intl`'s, which prints "Sept" for September in en-GB on
 * Node 22.22.3 (contract executed claim E-20). Pure functions of their input and, where no zone is named,
 * of the running process's zone: a client component passes none and so gets the device's (7.5.8).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DECLARED_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

function written(year: string, month: number | null, day: number | null): string {
  const m = month === null ? '' : `${MONTHS[month - 1]} `;
  return `${day === null ? '' : `${day} `}${m}${year}`;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The days a month has in a year: 29 for February of a leap year. `month` is 1 to 12. */
function daysIn(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
}

function digits(year: string, month: string | undefined, day: string | undefined, original: string): string {
  const m = month === undefined ? null : Number(month);
  const d = day === undefined ? null : Number(day);
  if ((m !== null && (m < 1 || m > 12)) || (d !== null && (d < 1 || m === null || d > daysIn(Number(year), m)))) {
    throw new RangeError(`not a date: ${JSON.stringify(original)}`);
  }
  return written(year, m, d);
}

const formatters = new Map<string, Intl.DateTimeFormat>();
/** One `Intl.DateTimeFormat` per (locale, options, zone): they are costly to build. */
function formatter(locale: string, options: Intl.DateTimeFormatOptions, timeZone: string | undefined): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone ?? ''}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, timeZone === undefined ? options : { ...options, timeZone });
    formatters.set(key, f);
  }
  return f;
}

/** `YYYY-MM-DDTHH:MM:SS.sssZ`, the only form of a `UtcInstant` (SRS line 1276); `Date` also reads "2026-11", which is no instant. */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function instantOf(value: Date | UtcInstant, original: string): Date {
  const d = value instanceof Date ? value : UTC_INSTANT.test(value) ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(d.getTime())) throw new RangeError(`not an instant: ${JSON.stringify(original)}`);
  return d;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const p = parts.find((x) => x.type === type);
  if (!p) throw new RangeError(`no ${type} in the formatted date`);
  return p.value;
}

/**
 * A day: "2 Nov 2026". A `CalendarDate` (`YYYY-MM-DD`) is written from its digits and is not converted to a
 * zone; a `Date` or an instant is written as the date it is in `timeZone` (default: the process's).
 */
export function formatDay(d: Date | CalendarDate | UtcInstant, timeZone?: string): string {
  if (typeof d === 'string') {
    const cal = CALENDAR_DATE.exec(d);
    if (cal) return digits(cal[1], cal[2], cal[3], d);
  }
  const instant = instantOf(d, String(d));
  const parts = formatter('en-GB', { year: 'numeric', month: 'numeric', day: 'numeric' }, timeZone).formatToParts(instant);
  return written(String(Number(part(parts, 'year'))), Number(part(parts, 'month')), Number(part(parts, 'day')));
}

/**
 * A day and a 24-hour clock time with no zone name: "11 Nov 2026, 11:23" (voice rule 10). The instant is written as it
 * is in `timeZone` (default: the process's). A caller that shows UTC says so beside it (components/ui/LocalTime.tsx).
 */
export function formatDayTime(t: UtcInstant, timeZone?: string): string {
  const instant = instantOf(t, t);
  const clock = formatter('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, timeZone).formatToParts(instant);
  return `${formatDay(instant, timeZone)}, ${part(clock, 'hour')}:${part(clock, 'minute')}`;
}

/** A declared date at its own precision: "12 Oct 2026", "Oct 2026" or "2026". */
export function formatDeclaredDate(d: DeclaredDate): string {
  const m = DECLARED_DATE.exec(d);
  if (!m) throw new RangeError(`not a declared date: ${JSON.stringify(d)}`);
  return digits(m[1], m[2], m[3], d);
}

/** The zone name in the first of these locales that gives a name and not an offset ("GMT+3", "UTC+3"). */
const ZONE_NAME_LOCALES = ['en-UG', 'en-US', 'en-GB'] as const;
const OFFSET_FORM = /^(GMT|UTC)/;

/** A time: "10:42 EAT" (24 hours, with the zone's abbreviation, or its `GMT` form when it has no name). */
export function formatTime(t: UtcInstant, timeZone?: string): string {
  const instant = instantOf(t, t);
  const clock = formatter('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, timeZone).formatToParts(instant);
  let zone = '';
  for (const locale of ZONE_NAME_LOCALES) {
    zone = part(formatter(locale, { timeZoneName: 'short' }, timeZone).formatToParts(instant), 'timeZoneName');
    if (!OFFSET_FORM.test(zone)) break;
  }
  return `${part(clock, 'hour')}:${part(clock, 'minute')} ${zone}`;
}
