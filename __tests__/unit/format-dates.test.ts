import { describe, it, expect } from 'vitest';
import { formatDay, formatDeclaredDate, formatTime } from '@/lib/format/dates';

const here = Intl.DateTimeFormat().resolvedOptions().timeZone;

describe('lib/format/dates (SRS 7.5.8)', () => {
  it('7.5.8 (helper): dates are day, short month, year, never a bare Intl month', () => {
    expect(formatDay(new Date('2026-09-02T07:42:00Z'), 'Africa/Nairobi')).toBe('2 Sep 2026');   // Intl en-GB prints "2 Sept 2026" on Node 22.22.3
    expect(formatDay('2026-11-02T07:42:00.000Z', 'Africa/Nairobi')).toBe('2 Nov 2026');
    expect(formatDay('2026-11-02', 'America/New_York')).toBe('2 Nov 2026');                     // a CalendarDate is not zone-converted
    expect(formatDay('2026-11-01T22:30:00.000Z', 'Africa/Nairobi')).toBe('2 Nov 2026');          // the instant's date in the zone
  });

  it('7.5.8 (helper): every month is written with the fixed three-letter list, and a day has no leading zero', () => {
    const months = Array.from({ length: 12 }, (_, i) => formatDay(`2026-${String(i + 1).padStart(2, '0')}-09`));
    expect(months).toEqual(['9 Jan 2026', '9 Feb 2026', '9 Mar 2026', '9 Apr 2026', '9 May 2026', '9 Jun 2026', '9 Jul 2026', '9 Aug 2026', '9 Sep 2026', '9 Oct 2026', '9 Nov 2026', '9 Dec 2026']);
    expect(formatDay('2026-11-30')).toBe('30 Nov 2026');
  });

  it('7.5.8 (helper): the same instant is a different day in a different zone, and with no zone it is the running process\'s', () => {
    const instant = '2026-11-02T22:30:00.000Z';
    expect(formatDay(instant, 'Africa/Nairobi')).toBe('3 Nov 2026');
    expect(formatDay(instant, 'America/New_York')).toBe('2 Nov 2026');
    expect(formatDay(instant)).toBe(formatDay(instant, here));
    expect(formatDay(new Date(instant))).toBe(formatDay(instant));
  });

  it('7.5.8 (helper): a value that is not a date is a RangeError, not "undefined" or "Invalid Date" on a page', () => {
    for (const bad of ['', 'yesterday', '2026-13-01', '2026-00-10', '2026-11-32', '2026-11-00', '2026-11', new Date(Number.NaN)])
      expect(() => formatDay(bad as string), String(bad)).toThrow(RangeError);
  });

  it('7.5.8 (helper): a declared date shows its precision', () => {
    expect(['2026-10-12', '2026-10', '2026'].map(formatDeclaredDate)).toEqual(['12 Oct 2026', 'Oct 2026', '2026']);
    expect(formatDeclaredDate('2026-01-05')).toBe('5 Jan 2026');
    for (const bad of ['', '26', '2026-1', '2026-13', '2026-10-32', '2026-10-12T00:00', 'Oct 2026'])
      expect(() => formatDeclaredDate(bad), bad).toThrow(RangeError);
  });

  it('7.5.8 (helper): times are HH:MM in 24 hours with the zone abbreviation', () => {
    expect(formatTime('2026-11-02T07:42:00.000Z', 'Africa/Nairobi')).toBe('10:42 EAT');          // en-UG; en-GB and en-US print GMT+3
    expect(formatTime('2026-11-02T07:42:00.000Z', 'America/New_York')).toBe('02:42 EST');        // en-US
    expect(formatTime('2026-11-02T07:42:00.000Z', 'Europe/Berlin')).toBe('08:42 CET');           // en-GB
  });

  it('7.5.8 (helper): midnight is 00:00 and not 24:00, a zone without an abbreviation falls back to the GMT form, and a bad instant is a RangeError', () => {
    expect(formatTime('2026-11-01T21:00:00.000Z', 'Africa/Nairobi')).toBe('00:00 EAT');
    expect(formatTime('2026-11-02T07:42:00.000Z', 'Asia/Kolkata')).toMatch(/^13:12 (IST|GMT\+5:30)$/);
    expect(formatTime('2026-11-02T07:42:00.000Z', 'Europe/London')).toBe('07:42 GMT');
    for (const bad of ['', 'noon', '2026-11-02']) expect(() => formatTime(bad, 'Africa/Nairobi'), bad).toThrow(RangeError);
    expect(formatTime('2026-11-02T07:42:00.000Z')).toBe(formatTime('2026-11-02T07:42:00.000Z', here));
  });
});
