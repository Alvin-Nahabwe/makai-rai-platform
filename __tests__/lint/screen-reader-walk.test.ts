import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * NFR-A11Y-07 (SRS 9.x; UX-32; call R-58): the owner walks J-05 and J-09 with a screen reader on the release
 * candidate and records the findings in docs/accessibility/screen-reader-walk-v0.6.0.md. This file checks the sheet
 * has a row for each journey step (SRS lines 368-378 and 401-405) and, at the release candidate, that the walk was
 * recorded and no serious or critical finding is open. The walk itself is the owner's; nothing here performs it.
 */
const SHEET = 'docs/accessibility/screen-reader-walk-v0.6.0.md';

/** The inclusive list of integers from a to b. */
function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

describe('NFR-A11Y-07: the screen-reader walk sheet', () => {
  it('NFR-A11Y-07: the walk sheet has a row for every step of J-05 and J-09', () => {
    const rows = readFileSync(SHEET, 'utf8').split('\n').filter((l) => /^\| J-0[59] step \d+ \|/.test(l));
    expect(rows.map((r) => r.split('|')[1].trim())).toEqual([...range(1, 11).map((n) => `J-05 step ${n}`), ...range(1, 5).map((n) => `J-09 step ${n}`)]);
  });

  it.skipIf(process.env.RELEASE_CANDIDATE !== '1')('NFR-A11Y-07: at release no serious or critical finding is open, and the walk is recorded', () => {
    const t = readFileSync(SHEET, 'utf8');
    expect(t).toMatch(/^Tool: (NVDA|VoiceOver) \S+/m); expect(t).toMatch(/^Build: [0-9a-f]{7,40}$/m);
    const open = t.split('\n').filter((l) => /^\| J-0[59] step/.test(l)).filter((l) => /\| (serious|critical) \| open \|$/.test(l));
    expect(open).toEqual([]);
  });
});
