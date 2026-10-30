/**
 * Markers: strings no real text contains, planted in a free-text field so that a scan of a log, a URL or a
 * page can tell record text from everything else (NFR-PRIV-03). `ZZMARK-<field>-<seq>-QX` carries the field
 * and the sequence number, so a finding names the field that leaked.
 *
 * `markerText` has the shape of `FixtureTextSource` (`__tests__/helpers/recordFixture.ts`), so it can be
 * passed as `BuildOrgOptions.text`.
 */

export function markerFor(field: string, seq: number): string {
  return `ZZMARK-${field}-${seq}-QX`;
}

/**
 * Finds markers in a string: `'...'.match(MARKER_PATTERN)`. It carries the `g` flag, so `.test()` and
 * `.exec()` on it keep a position between calls; use `match` or `matchAll`, or build a new RegExp from `.source`.
 */
export const MARKER_PATTERN: RegExp = /ZZMARK-[A-Za-z0-9_.-]+-\d+-QX/g;

/** Plain fixture text that carries the marker of its field. */
export function markerText(field: string, seq: number): string {
  return `Fixture ${field} ${seq} ${markerFor(field, seq)}`;
}
