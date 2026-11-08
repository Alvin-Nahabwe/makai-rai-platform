import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { releaseWaiver, type ReleaseWaiver } from '../helpers/releaseWaivers';

/**
 * NFR-A11Y-07 (SRS 9.x; UX-32; call R-58): the owner walks J-05 and J-09 with a screen reader on the release
 * candidate and records the findings in docs/accessibility/screen-reader-walk-v0.6.0.md. This file checks the sheet
 * has a row for each journey step (SRS lines 368-378 and 401-405) and, at the release candidate, that the walk was
 * recorded: every step row has a Status, every row that did not pass has a Severity, and no row of any table is a
 * serious or critical finding still open. The walk itself is the owner's; nothing here performs it.
 */
const SHEET = 'docs/accessibility/screen-reader-walk-v0.6.0.md';
const STATUSES = ['pass', 'fixed', 'accepted', 'open'];
const SEVERITIES = ['critical', 'serious', 'moderate', 'minor'];

/** The inclusive list of integers from a to b. */
function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/** The cells of a markdown table row, trimmed, without the empty first and last pieces of the leading and trailing pipes. */
function cells(row: string): string[] {
  return row.split('|').slice(1, -1).map((c) => c.trim());
}

/** Body rows of every table in `text`: lines starting with a pipe, minus each table's header and its separator. */
function tableBodyRows(text: string): string[] {
  const lines = text.split('\n');
  return lines.filter((l, i) => l.startsWith('| ') && !/^\|[\s|:-]+\|$/.test(l) && !/^\|[\s|:-]+\|$/.test(lines[i + 1] ?? ''));
}

/** Rows of any table that record a serious or critical finding still open. */
export function openSeriousRows(text: string): string[] {
  return tableBodyRows(text).filter((r) => /\|\s*(serious|critical)\s*\|\s*open\s*\|\s*$/i.test(r));
}

/** Journey-step rows whose Status is not one of STATUSES, or which did not pass and have no Severity from SEVERITIES. */
export function unrecordedSteps(text: string): string[] {
  return text.split('\n').filter((l) => /^\| J-0[59] step \d+ \|/.test(l)).filter((r) => {
    const c = cells(r);
    const status = c[c.length - 1].toLowerCase();
    const severity = c[c.length - 2].toLowerCase();
    if (!STATUSES.includes(status)) return true;
    return status !== 'pass' && !SEVERITIES.includes(severity);
  }).map((r) => cells(r)[0]);
}

/** The release-waiver case that lets the owner's deferral of the walk (register row D-301) pass the release check. */
export const WALK_CASE = 'NFR-A11Y-07 screen-reader-walk';

/**
 * What the release check holds against the walk sheet: the problems with the record of the walk and the open serious
 * findings, or none when `waiver` is the owner's complete waiver of WALK_CASE for this release that covers SHEET. Any other waiver counts for nothing. A waiver skips only
 * those two assertions; the sheet's rows (the first case) are checked whatever the owner decided.
 */
export function walkReleaseProblems(text: string, waiver: ReleaseWaiver | undefined): string[] {
  if (waiver?.case === WALK_CASE && waiver.covers.includes(SHEET)) return [];
  const problems: string[] = [];
  if (!/^Tool: (NVDA|VoiceOver) \S+/m.test(text)) problems.push('no Tool line');
  if (!/^Build: [0-9a-f]{7,40}$/m.test(text)) problems.push('no Build line');
  problems.push(...unrecordedSteps(text).map((s) => `${s} not recorded`), ...openSeriousRows(text).map((r) => `open: ${r}`));
  return problems;
}

describe('NFR-A11Y-07: the screen-reader walk sheet', () => {
  it('NFR-A11Y-07: the walk sheet has a row for every step of J-05 and J-09', () => {
    const rows = readFileSync(SHEET, 'utf8').split('\n').filter((l) => /^\| J-0[59] step \d+ \|/.test(l));
    expect(rows.map((r) => r.split('|')[1].trim())).toEqual([...range(1, 11).map((n) => `J-05 step ${n}`), ...range(1, 5).map((n) => `J-09 step ${n}`)]);
  });

  it('NFR-A11Y-07: the release check finds an open serious row in any table, and a step that was not recorded', () => {
    const sheet = [
      '| Journey step | What to do | What should be announced | Result | Severity | Status |',
      '|---|---|---|---|---|---|',
      '| J-05 step 1 | a | b | read well | - | pass |',
      '| J-05 step 2 | a | b | the heading was skipped | serious | open |',
      '| J-05 step 3 | a | b | | | |',
      '| J-05 step 4 | a | b | fixed in abc1234 | moderate | fixed |',
      '| J-05 step 5 | a | b | no announcement | | open |',
      '',
      '| Where | What was announced | Severity | Status |',
      '|---|---|---|---|',
      '| S-12 | the live region repeats | Critical | open |',
      '| S-18 | slow | minor | accepted |',
    ].join('\n');
    expect(openSeriousRows(sheet)).toEqual(['| J-05 step 2 | a | b | the heading was skipped | serious | open |', '| S-12 | the live region repeats | Critical | open |']);
    expect(unrecordedSteps(sheet)).toEqual(['J-05 step 3', 'J-05 step 5']);
  });

  it('NFR-A11Y-07: an unwalked sheet fails the release check unless the owner waived the walk for this release', () => {
    const unwalked = ['Tool: ', '| J-05 step 1 | a | b | | | |', '| S-12 | x | critical | open |'].join('\n');
    const all = ['no Tool line', 'no Build line', 'J-05 step 1 not recorded', 'open: | S-12 | x | critical | open |'];
    const dir = mkdtempSync(path.join(tmpdir(), 'walk-waiver-'));
    try {
      const entry = { case: WALK_CASE, covers: [SHEET], owner_words: 'postpone it', date: '2026-11-08', register_row: 'D-999', release: '0.6.0' };
      const f = path.join(dir, 'w.json');
      const read = (waivers: unknown[], release = '0.6.0') => {
        writeFileSync(f, JSON.stringify({ waivers }));
        return releaseWaiver(WALK_CASE, f, release);
      };
      expect(walkReleaseProblems(unwalked, read([entry])), 'waived for 0.6.0').toEqual([]);
      expect(walkReleaseProblems(unwalked, read([entry], '0.7.0')), 'an entry of another release waives nothing').toEqual(all);
      expect(walkReleaseProblems(unwalked, read([])), 'no entry').toEqual(all);
      expect(walkReleaseProblems(unwalked, read([{ ...entry, covers: ['data/help-contact.json'] }])), 'an entry covering another file waives nothing').toEqual(all);
      expect(walkReleaseProblems(unwalked, { ...entry, case: 'UX-03 help-contact-pending' } as ReleaseWaiver), 'a waiver of another case waives nothing').toEqual(all);
      expect(() => read([{ ...entry, register_row: undefined }]), 'a malformed entry fails the read').toThrow(/release-waivers.*register row/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.env.RELEASE_CANDIDATE !== '1')('NFR-A11Y-07: at release the walk is recorded and no serious or critical finding is open, or the owner deferred the walk', () => {
    const waiver = releaseWaiver(WALK_CASE);
    if (waiver) console.log(`NFR-A11Y-07: the screen-reader walk is deferred by the owner (${waiver.register_row}, ${waiver.date}): not checked at ${waiver.release}`);
    expect(walkReleaseProblems(readFileSync(SHEET, 'utf8'), waiver), 'the walk record, or the owner waiver of it in docs/releases/release-waivers.json').toEqual([]);
  });
});
