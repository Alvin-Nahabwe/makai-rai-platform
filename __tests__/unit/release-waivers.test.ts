import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RELEASE_WAIVERS_FILE, WAIVABLE_CASES, releaseWaiver } from '../helpers/releaseWaivers';

/**
 * The owner's waivers of a release-check case (FIX-3). A case named in WAIVABLE_CASES passes under
 * RELEASE_CANDIDATE=1 only when docs/releases/release-waivers.json holds a complete entry for it: the case id, the
 * owner's verbatim words, the date and the register row. Anything less, and any entry for another case, fails.
 */

const OK = {
  case: 'UX-03 help-contact-pending',
  covers: ['data/help-contact.json'],
  owner_words: 'Ship pending text',
  date: '2026-11-06',
  register_row: 'D-999',
};

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function file(body: unknown): string {
  dir = mkdtempSync(path.join(tmpdir(), 'release-waivers-'));
  const p = path.join(dir, 'release-waivers.json');
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  return p;
}

describe('release waivers', () => {
  it('FR-ACC-02 UX-03 FIX-3: the two waivable cases are exactly the owner\'s two decisions', () => {
    expect([...WAIVABLE_CASES].sort()).toEqual(['FR-ACC-02 legal-placeholder', 'UX-03 help-contact-pending']);
    expect(RELEASE_WAIVERS_FILE).toBe('docs/releases/release-waivers.json');
  });

  it('FR-ACC-02 UX-03 FIX-3: a complete entry waives its case', () => {
    expect(releaseWaiver('UX-03 help-contact-pending', file({ waivers: [OK] }))).toEqual(OK);
  });

  it('FR-ACC-02 UX-03 FIX-3: a missing entry waives nothing', () => {
    expect(releaseWaiver('FR-ACC-02 legal-placeholder', file({ waivers: [OK] }))).toBeUndefined();
    expect(releaseWaiver('UX-03 help-contact-pending', file({ waivers: [] }))).toBeUndefined();
  });

  it('FR-ACC-02 UX-03 FIX-3: an entry for a case nobody can waive fails the read', () => {
    expect(() => releaseWaiver('UX-03 help-contact-pending', file({ waivers: [OK, { ...OK, case: 'NFR-MNT-03 must-ids' }] }))).toThrow(
      /NFR-MNT-03 must-ids.*not a waivable case/,
    );
    // Asking for one is a programming error too.
    expect(() => releaseWaiver('NFR-MNT-03 must-ids', file({ waivers: [] }))).toThrow(/not a waivable case/);
  });

  it.each([
    ['no owner words', { owner_words: '' }],
    ['a date that is not YYYY-MM-DD', { date: '6 Nov 2026' }],
    ['no register row', { register_row: null }],
    ['a register row that is not D-<n>', { register_row: 'pending' }],
    ['nothing covered', { covers: [] }],
  ])('FR-ACC-02 UX-03 FIX-3: an entry with %s fails the read', (_label, change) => {
    expect(() => releaseWaiver('UX-03 help-contact-pending', file({ waivers: [{ ...OK, ...change }] }))).toThrow(/release-waivers/);
  });

  it('FR-ACC-02 UX-03 FIX-3: two entries for one case, or a file that is not the shape, fail the read', () => {
    expect(() => releaseWaiver('UX-03 help-contact-pending', file({ waivers: [OK, OK] }))).toThrow(/twice/);
    expect(() => releaseWaiver('UX-03 help-contact-pending', file('{"waivers": {}}'))).toThrow(/release-waivers/);
    expect(() => releaseWaiver('UX-03 help-contact-pending', file('not json'))).toThrow();
  });

  it("FR-ACC-02 UX-03 FIX-3: the committed file holds the owner's two decisions, word for word", () => {
    const raw = JSON.parse(readFileSync(RELEASE_WAIVERS_FILE, 'utf8')) as { waivers: Array<Record<string, unknown>> };
    const byCase = Object.fromEntries(raw.waivers.map((w) => [w.case, w]));
    expect(Object.keys(byCase).sort()).toEqual([...WAIVABLE_CASES].sort());
    expect(byCase['FR-ACC-02 legal-placeholder']).toMatchObject({
      owner_words: 'Ship placeholders',
      date: '2026-11-06',
      covers: ['data/legal/cross-border-consent/1.md', 'data/legal/organisation-agreement/1.md'],
      register_row: 'D-292',
    });
    expect(byCase['UX-03 help-contact-pending']).toMatchObject({
      owner_words: 'Ship pending text', date: '2026-11-06', covers: ['data/help-contact.json'], register_row: 'D-293',
    });
    // Both entries are complete, so both read without throwing.
    for (const c of WAIVABLE_CASES) expect(releaseWaiver(c)?.case).toBe(c);
  });
});
