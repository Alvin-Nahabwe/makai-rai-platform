import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReasonCodeEntry } from '@/types/content';
import { declaredDateFromParts, utcPlus14Date, validateDecisionFields, reasonLength, REASON_MAX, type DecisionFieldsInput } from '@/lib/decision/rules';
import { M11 } from '@/lib/decision/copy';

/** Two codes of SRS 10.1.5 (lines 3986-3999), one per status that takes a code. */
const CODES: readonly ReasonCodeEntry[] = [
  { code: 'ny_planned_later', status: 'not_yet', label: 'Planned for a later point in the project', useWhen: 'x', reasonMustSay: 'x' },
  { code: 'na_other', status: 'not_applicable', label: 'Other', useWhen: 'x', reasonMustSay: 'x' },
];

const base: DecisionFieldsInput = { questionType: 'likert-5', options: [], reasonCodes: CODES, status: 'done', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: 'r', decidedBy: { kind: 'outside_role', role: 'funder' }, declaredDate: '2026-10-12' };

describe('lib/decision/rules.ts', () => {
  it('UX-10 FR-DEC-01: empty day means month precision, empty day and month mean year precision', () => {
    expect(declaredDateFromParts({ day: '', month: '10', year: '2026' })).toEqual({ date: '2026-10', precision: 'month' });
    expect(declaredDateFromParts({ day: '', month: '', year: '2026' })).toEqual({ date: '2026', precision: 'year' });
    expect(declaredDateFromParts({ day: '7', month: '3', year: '2026' })).toEqual({ date: '2026-03-07', precision: 'day' });
  });

  it('UX-10 M-11: a missing year, a day that does not exist and a day without a month are refused with M-11 text', () => {
    expect(declaredDateFromParts({ day: '', month: '10', year: '' })).toEqual({ field: 'declaredDate', message: 'Enter at least the year the decision was made.' });
    expect(declaredDateFromParts({ day: '31', month: '2', year: '2026' })).toEqual({ field: 'declaredDate', message: 'February has 28 days.' });
    expect(declaredDateFromParts({ day: '29', month: '2', year: '2028' })).toEqual({ date: '2028-02-29', precision: 'day' });
    expect(declaredDateFromParts({ day: '5', month: '', year: '2026' })).toMatchObject({ field: 'declaredDate' });
    expect(declaredDateFromParts({ day: '', month: '', year: '0000' })).toEqual({ field: 'declaredDate', message: M11.yearFormat });
    expect(validateDecisionFields({ ...base, declaredDate: '0000-01-01' }, '2026-10-30')).toEqual([{ field: 'declaredDate', message: M11.yearFormat }]);
  });

  it('FR-DEC-02: at 00:30 East Africa Time today with day precision and this month with month precision are accepted', () => {
    const latest = utcPlus14Date(new Date('2026-10-29T21:30:00Z'));     // 00:30 EAT on 30 Oct
    expect(latest).toBe('2026-10-30');
    expect(validateDecisionFields({ ...base, declaredDate: '2026-10-30' }, latest)).toEqual([]);
    expect(validateDecisionFields({ ...base, declaredDate: '2026-10' }, latest)).toEqual([]);
    expect(validateDecisionFields({ ...base, declaredDate: '2026-11-01' }, latest)).toEqual([{ field: 'declaredDate', message: 'The date cannot be later than today.' }]);
  });

  it('UX-12 FR-DEC-01 M-11: the reason is 1 to 4,000 code points', () => {
    expect(validateDecisionFields({ ...base, reason: '   ' }, '2026-10-30')).toEqual([{ field: 'reason', message: 'Write a reason. Say what is in place, where it is recorded, and what is missing.' }]);
    expect(validateDecisionFields({ ...base, reason: 'a'.repeat(4001) }, '2026-10-30')).toEqual([{ field: 'reason', message: 'The reason is 4,001 characters. The limit is 4,000.' }]);
    expect(validateDecisionFields({ ...base, reason: '\u{1F600}'.repeat(4000) }, '2026-10-30')).toEqual([]);
    expect([REASON_MAX, reasonLength('\u{1F600}a')]).toEqual([4000, 2]);
  });

  it('UX-09 FR-DEC-01: a reason code is required with not applicable and not yet, from that status list, and refused with done and partly', () => {
    expect(validateDecisionFields({ ...base, status: 'not_yet' }, '2026-10-30')).toEqual([{ field: 'reasonCode', message: M11.reasonCode }]);
    expect(validateDecisionFields({ ...base, status: 'not_yet', reasonCode: 'na_other' }, '2026-10-30')).toEqual([{ field: 'reasonCode', message: M11.reasonCodeNotAllowed }]);
    expect(validateDecisionFields({ ...base, status: 'not_yet', reasonCode: 'ny_planned_later' }, '2026-10-30')).toEqual([]);
    expect(validateDecisionFields({ ...base, status: 'done', reasonCode: 'ny_planned_later' }, '2026-10-30')).toEqual([{ field: 'reasonCode', message: M11.reasonCodeNotAllowed }]);
  });

  it('FR-DEC-02: status for practice and checklist questions, scope answer only for the gate, options of the question only', () => {
    expect(validateDecisionFields({ ...base, status: null }, '2026-10-30')).toEqual([{ field: 'status', message: 'Choose a status.' }]);
    expect(validateDecisionFields({ ...base, questionType: 'gate', status: 'done' }, '2026-10-30')).toContainEqual(expect.objectContaining({ field: 'status' }));
    expect(validateDecisionFields({ ...base, questionType: 'gate', status: null, scopeAnswer: null }, '2026-10-30')).toEqual([{ field: 'scopeAnswer', message: M11.scopeAnswer }]);
    expect(validateDecisionFields({ ...base, questionType: 'checklist', options: ['A', 'B'], optionsInPlace: ['C'] }, '2026-10-30')).toContainEqual(expect.objectContaining({ field: 'optionsInPlace' }));
    expect(validateDecisionFields({ ...base, decidedBy: null, reason: 'a\u0000b' }, '2026-10-30').map((e) => e.field)).toEqual(['reason', 'decidedBy']);
  });

  it('NFR-SEC-11 FR-DEC-02: a lone surrogate, which cannot be stored unchanged, is refused like a NUL character', () => {
    expect(validateDecisionFields({ ...base, reason: 'a\uD800b' }, '2026-10-30')).toEqual([{ field: 'reason', message: M11.reasonNul }]);
    expect(validateDecisionFields({ ...base, reason: 'a\u0000b' }, '2026-10-30')).toEqual([{ field: 'reason', message: M11.reasonNul }]);
  });

  it('FR-DEC-01: the shared rules and copy reach no module outside types/ and lib/decision/, so a client component can import them', () => {
    // The contract row asks both files to import only types/ (so the browser bundle pulls no server code); rules.ts takes its
    // texts from copy.ts so each text has one copy. This pins the property the import rule exists for, on both files.
    for (const file of ['lib/decision/rules.ts', 'lib/decision/copy.ts']) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      const specifiers = [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s*\(?\s*['"]([^'"]+)['"]/g, /\brequire\s*\(\s*['"]([^'"]+)['"]/g]
        .flatMap((re) => [...src.matchAll(re)].map((m) => m[1]));
      expect(specifiers.length, file).toBeGreaterThan(0);
      expect(specifiers.filter((s) => !/^(@\/types\/|\.\.\/\.\.\/types\/|\.\/copy$)/.test(s)), file).toEqual([]);
    }
  });
});
