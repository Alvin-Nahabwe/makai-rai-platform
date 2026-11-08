import { readFileSync, statSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { scanLines } from '../../__tests__/helpers/logCapture';

/**
 * Server-log capture for a live run (NFR-PRIV-03, NFR-OBS-05). `playwright.config.ts` redirects the
 * web server's stdout and stderr to `test-results/server.log`; a test takes the lines the server
 * wrote while it ran by starting a capture before its action and stopping it after.
 *
 * Colour: `next dev` and `next start` colour their output when CI sets `FORCE_COLOR`, so a line may
 * hold ANSI escape sequences in the middle of the text a scan looks for. Every line is stripped of
 * them before it is returned or scanned.
 */

export const SERVER_LOG = 'test-results/server.log';

/**
 * H0-internal (not a contract symbol; it exists so the self-test can aim at other files). Records the
 * size of `path` now; `stop()` returns the lines appended since.
 *
 * A missing file or one of size 0 is a failure at the call, not an empty capture: the web server has
 * printed its first line before any test runs, so a missing or empty log means the redirect broke, and
 * an empty capture would pass `expectNoMarkersOrEmails` for the wrong reason (round 10, R10-12). A file
 * smaller at `stop()` than at the call was truncated or replaced, so `stop()` rejects.
 */
export function captureFrom(path: string): { stop(): Promise<string[]> } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`server log missing: ${path} (the web server redirect did not run)`);
    }
    throw e;
  }
  if (size === 0) {
    throw new Error(`server log empty: ${path} (the web server prints a line before any test runs, so the redirect did not work)`);
  }
  return {
    async stop() {
      const bytes = readFileSync(path);
      if (bytes.length < size) {
        throw new Error(`server log truncated: ${path} held ${size} bytes when the capture started and holds ${bytes.length} now`);
      }
      const text = stripVTControlCharacters(bytes.subarray(size).toString('utf8'));
      const lines = text.split(/\r?\n/);
      if (lines.at(-1) === '') lines.pop();
      return lines;
    },
  };
}

/** Starts a capture of the web server's log. Throws when the log is missing or empty (see `captureFrom`). */
export function startServerLogCapture(): { stop(): Promise<string[]> } {
  return captureFrom(SERVER_LOG);
}

/**
 * Fails when any line holds a test marker (`ZZMARK-<field>-<n>-QX`) or an email address: record text
 * and addresses never enter a log (NFR-PRIV-03). The failure lists each finding with its line number.
 */
export function expectNoMarkersOrEmails(lines: string[]): void {
  const clean = lines.map((l) => stripVTControlCharacters(l));
  const found = scanLines(clean, { markers: true, emails: true });
  if (found.length === 0) return;
  const shown = found.slice(0, 20).map((f) => `line ${f.line}: ${f.kind} ${f.match}`);
  throw new Error(`${found.length} marker or email finding(s) in ${clean.length} log line(s)\n${shown.join('\n')}${found.length > 20 ? `\nand ${found.length - 20} more` : ''}`);
}
