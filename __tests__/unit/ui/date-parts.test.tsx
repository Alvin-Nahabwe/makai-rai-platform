import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { datePartsOf, parseDateParts } from '@/lib/ui/dateParts';

/** Plan 1A Task 4: the pure date helper beside DateField. A calendar date is 'YYYY-MM-DD' (types/record.ts). */

const EMPTY = { day: '', month: '', year: '' };

describe('datePartsOf', () => {
  it('splits a calendar date into the three boxes, without leading zeros', () => {
    expect(datePartsOf('2026-02-11')).toEqual({ day: '11', month: '2', year: '2026' });
    expect(datePartsOf('2026-11-05')).toEqual({ day: '5', month: '11', year: '2026' });
  });

  it('a date given to the month or the year leaves the missing boxes empty', () => {
    expect(datePartsOf('2026-02')).toEqual({ day: '', month: '2', year: '2026' });
    expect(datePartsOf('2026')).toEqual({ day: '', month: '', year: '2026' });
  });

  it('null gives three empty strings', () => {
    expect(datePartsOf(null)).toEqual(EMPTY);
  });
});

describe('parseDateParts', () => {
  it('three empty boxes are no date', () => {
    expect(parseDateParts(EMPTY)).toEqual({ ok: true, value: null });
  });

  it('some boxes empty is incomplete', () => {
    expect(parseDateParts({ day: '11', month: '', year: '2026' })).toEqual({ ok: false, error: 'incomplete' });
    expect(parseDateParts({ day: '', month: '', year: '2026' })).toEqual({ ok: false, error: 'incomplete' });
  });

  it('a day the month does not have, or a box that is not a number, is not a date', () => {
    expect(parseDateParts({ day: '31', month: '2', year: '2026' })).toEqual({ ok: false, error: 'not_a_date' });
    expect(parseDateParts({ day: '29', month: '2', year: '2026' })).toEqual({ ok: false, error: 'not_a_date' });
    expect(parseDateParts({ day: '1', month: '13', year: '2026' })).toEqual({ ok: false, error: 'not_a_date' });
    expect(parseDateParts({ day: '0', month: '1', year: '2026' })).toEqual({ ok: false, error: 'not_a_date' });
    expect(parseDateParts({ day: '1x', month: '1', year: '2026' })).toEqual({ ok: false, error: 'not_a_date' });
    expect(parseDateParts({ day: '1', month: '1', year: '26' })).toEqual({ ok: false, error: 'not_a_date' });
    expect(parseDateParts({ day: '1.5', month: '1', year: '2026' })).toEqual({ ok: false, error: 'not_a_date' });
    expect(parseDateParts({ day: '1', month: '1', year: '0000' })).toEqual({ ok: false, error: 'not_a_date' });
  });

  it('a whole date gives the calendar date, padded, and leap days hold', () => {
    expect(parseDateParts({ day: '11', month: '2', year: '2026' })).toEqual({ ok: true, value: '2026-02-11' });
    expect(parseDateParts({ day: ' 29 ', month: '02', year: '2028' })).toEqual({ ok: true, value: '2028-02-29' });
  });

  it('reuses daysInMonth from lib/decision/copy.ts', () => {
    expect(readFileSync('lib/ui/dateParts.ts', 'utf8')).toMatch(/import \{ daysInMonth \} from '@\/lib\/decision\/copy'/);
  });
});
