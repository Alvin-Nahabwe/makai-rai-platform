import { markerFor } from './markers';

/**
 * Text a team could type to run script in a page or break out of an attribute (NFR-SEC-11, SRS line 2956).
 * A fixture whose every free-text field holds all three must show them literally, in pages, PDFs and plain
 * text, and HTML-escaped in emails; a dialog listener (`e2e/helpers/dialogs.ts`) stays silent.
 */
export const HOSTILE_STRINGS = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', 'javascript:alert(1)'] as const;

/**
 * Evidence file names that are ordinary for a person and awkward for code (Review Focus 2): non-ASCII
 * letters and a dash with quotes, markup, a path walk, a right-to-left override, and a name of 255 bytes.
 */
export const HOSTILE_FILE_NAMES: readonly string[] = [
  'R\u00e9sum\u00e9 \u2013 consent "v2".pdf',
  '<img src=x onerror=alert(1)>.png',
  '../../etc/passwd.pdf',
  'invoice\u202Efdp.exe.pdf',
  `${'a'.repeat(251)}.pdf`,
];

/**
 * Hostile text that also carries the marker of its field, so one field is findable by both scans. Has the
 * shape of `FixtureTextSource` (`__tests__/helpers/recordFixture.ts`).
 */
export function hostileText(field: string, seq: number): string {
  return `${HOSTILE_STRINGS.join(' ')} ${markerFor(field, seq)}`;
}
