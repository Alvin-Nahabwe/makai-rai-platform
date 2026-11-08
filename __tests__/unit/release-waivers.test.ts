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
  release: '0.6.0',
};
/** The version the fixtures are read as, so the cases do not move when package.json does. */
const V = '0.6.0';

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
  it('FR-ACC-02 UX-03 NFR-A11Y-07 FIX-3: the waivable cases are exactly the owner\'s three decisions', () => {
    expect([...WAIVABLE_CASES].sort()).toEqual(['FR-ACC-02 legal-placeholder', 'NFR-A11Y-07 screen-reader-walk', 'UX-03 help-contact-pending']);
    expect(RELEASE_WAIVERS_FILE).toBe('docs/releases/release-waivers.json');
  });

  it('FR-ACC-02 UX-03 FIX-3: a complete entry waives its case', () => {
    expect(releaseWaiver('UX-03 help-contact-pending', file({ waivers: [OK] }), V)).toEqual(OK);
  });

  it('FR-ACC-02 UX-03 FIX-3: a missing entry waives nothing', () => {
    expect(releaseWaiver('FR-ACC-02 legal-placeholder', file({ waivers: [OK] }), V)).toBeUndefined();
    expect(releaseWaiver('UX-03 help-contact-pending', file({ waivers: [] }), V)).toBeUndefined();
  });

  it('FR-ACC-02 UX-03 FIX-3: an entry for a case nobody can waive fails the read', () => {
    expect(() => releaseWaiver('UX-03 help-contact-pending', file({ waivers: [OK, { ...OK, case: 'NFR-MNT-03 must-ids' }] }), V)).toThrow(
      /NFR-MNT-03 must-ids.*not a waivable case/,
    );
    // Asking for one is a programming error too.
    expect(() => releaseWaiver('NFR-MNT-03 must-ids', file({ waivers: [] }), V)).toThrow(/not a waivable case/);
  });

  it.each([
    ['no owner words', { owner_words: '' }],
    ['a date that is not YYYY-MM-DD', { date: '6 Nov 2026' }],
    ['no register row', { register_row: null }],
    ['a register row that is not D-<n>', { register_row: 'pending' }],
    ['nothing covered', { covers: [] }],
    ['no release', { release: undefined }],
    ['a release that is not a version', { release: 'next' }],
  ])('FR-ACC-02 UX-03 FIX-3: an entry with %s fails the read', (_label, change) => {
    expect(() => releaseWaiver('UX-03 help-contact-pending', file({ waivers: [{ ...OK, ...change }] }), V)).toThrow(/release-waivers/);
  });

  it('FR-ACC-02 UX-03 FIX-3: two entries for one case, or a file that is not the shape, fail the read', () => {
    expect(() => releaseWaiver('UX-03 help-contact-pending', file({ waivers: [OK, OK] }), V)).toThrow(/twice/);
    expect(() => releaseWaiver('UX-03 help-contact-pending', file('{"waivers": {}}'), V)).toThrow(/release-waivers/);
    expect(() => releaseWaiver('UX-03 help-contact-pending', file('not json'), V)).toThrow();
  });

  it('FR-ACC-02 UX-03 SFH-11: an entry written for another release waives nothing, so its case fails again in the next release', () => {
    expect(releaseWaiver('UX-03 help-contact-pending', file({ waivers: [OK] }), '0.7.0')).toBeUndefined();
    // Two releases may each hold one entry for a case; only the running release's counts.
    const next = { ...OK, release: '0.7.0', register_row: 'D-1000' };
    expect(releaseWaiver('UX-03 help-contact-pending', file({ waivers: [OK, next] }), '0.7.0')).toEqual(next);
  });

  it('CR-5 SFH-11: an incomplete entry for another case fails the read of this one', () => {
    const broken = { ...OK, case: 'FR-ACC-02 legal-placeholder', register_row: undefined };
    expect(() => releaseWaiver('UX-03 help-contact-pending', file({ waivers: [OK, broken] }), V)).toThrow(/FR-ACC-02 legal-placeholder.*register row/);
    // The same holds for an entry of another release: it is validated, then ignored.
    expect(() => releaseWaiver('UX-03 help-contact-pending', file({ waivers: [OK, { ...broken, release: '0.5.0' }] }), V)).toThrow(/register row/);
  });

  it("FR-ACC-02 UX-03 FIX-3: the committed file holds the owner's three decisions, word for word", () => {
    const raw = JSON.parse(readFileSync(RELEASE_WAIVERS_FILE, 'utf8')) as { waivers: Array<Record<string, unknown>> };
    const byCase = Object.fromEntries(raw.waivers.map((w) => [w.case, w]));
    expect(Object.keys(byCase).sort()).toEqual([...WAIVABLE_CASES].sort());
    expect(byCase['FR-ACC-02 legal-placeholder']).toMatchObject({
      owner_words: 'Ship placeholders',
      date: '2026-11-06',
      covers: ['data/legal/cross-border-consent/1.md', 'data/legal/organisation-agreement/1.md'],
      register_row: 'D-293', release: '0.6.0',
    });
    expect(byCase['UX-03 help-contact-pending']).toMatchObject({
      owner_words: 'Ship pending text', date: '2026-11-06', covers: ['data/help-contact.json'], register_row: 'D-294', release: '0.6.0',
    });
    expect(byCase['NFR-A11Y-07 screen-reader-walk']).toMatchObject({
      owner_words: 'postpone the screen reader accessibility check for later versions/releases. It is not a priority right now and should not block the release.',
      date: '2026-11-08', covers: ['docs/accessibility/screen-reader-walk-v0.6.0.md'], register_row: 'D-301', release: '0.6.0',
    });
    // An entry's release is the version of package.json, or it waives nothing (SFH-11).
    expect(JSON.parse(readFileSync('package.json', 'utf8')).version).toBe('0.6.0');
    // Every entry is complete, so each reads without throwing.
    for (const c of WAIVABLE_CASES) expect(releaseWaiver(c)?.case).toBe(c);
  });
});
