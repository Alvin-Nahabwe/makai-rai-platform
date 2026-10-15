// Moves the `Expires` field of public/.well-known/security.txt out to a year from today when
// fewer than 30 days remain, and leaves the file alone otherwise (G2-22, G2-10, D-06).
//
// RFC 9116 section 2.5.5 treats a security.txt past its `Expires` as stale, so a date that is
// only ever moved by hand lapses on the one day nobody remembers. The daily `security-txt-renewal`
// job in .github/workflows/ci.yml runs this script and opens a PR if the file changed.
//
//   node scripts/renew-security-txt.mjs [path]     (default: public/.well-known/security.txt)
//
// Built-ins only. The CI job runs this with a write token and installs nothing before it, so
// nothing here may import a package.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DAY_MS = 86_400_000;
/** Renew when fewer than this many days remain. A reader has at least this long to see a fresh file before the old one lapses. */
const RENEW_WHEN_UNDER_DAYS = 30;
/** How far out a renewed `Expires` is placed. RFC 9116 recommends under a year. */
const RENEW_TO_DAYS = 365;

const DEFAULT_FILE = fileURLToPath(new URL('../public/.well-known/security.txt', import.meta.url));

// Field names are case-insensitive (RFC 9116 section 2.3). The value is captured without a line ending,
// so a CRLF file keeps its CRLF. `#` lines are comments and never match, because the line must begin `Expires`.
const EXPIRES_LINE = /^([ \t]*expires[ \t]*:[ \t]*)([^\r\n]*)/gim;
// RFC 9116 asks for an RFC 3339 date-time. Only the UTC form is written, and only that is read, so that a
// hand edit to anything else is reported rather than guessed at.
const UTC_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/**
 * @param {string} value the text after `Expires:`
 * @returns {number} milliseconds since the epoch
 */
function parseExpires(value) {
  const m = UTC_DATE_TIME.exec(value.trim());
  const ms = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Number.NaN;
  // Date.UTC rolls an impossible date (month 13, day 40) over instead of failing: read it back.
  const ok = m && Number.isFinite(ms) && new Date(ms).toISOString().startsWith(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
  if (!ok) throw new Error(`the Expires value ${JSON.stringify(value)} is not a UTC date-time like 2027-10-14T00:00:00Z`);
  return ms;
}

/**
 * The text of a security.txt with its `Expires` renewed.
 *
 * With 30 days or more left the text comes back unchanged, byte for byte. With fewer than 30 left, or
 * the date already past, `Expires` becomes midnight UTC of today's UTC date plus 365 days, and every other
 * byte of the file is left as it was. Midnight, not the instant: the file never claims more than a year
 * from the day it was renewed, and running the job twice in one day changes nothing the second time.
 *
 * It throws, and writes nothing, when the file has no `Expires`, has two, or has one it cannot read: a
 * silent fallback here would leave a file that parses and quietly expires.
 *
 * @param {string} text the contents of security.txt
 * @param {Date} today the current instant
 * @returns {string} the text, renewed if it was due
 */
export function renewExpires(text, today) {
  if (!(today instanceof Date) || Number.isNaN(today.getTime())) throw new Error('today must be a valid Date');
  const matches = [...text.matchAll(EXPIRES_LINE)];
  if (matches.length === 0) throw new Error('security.txt has no Expires field');
  if (matches.length > 1) throw new Error('security.txt has more than one Expires field');

  const [match] = matches;
  const expiresAt = parseExpires(match[2]);
  if (expiresAt - today.getTime() >= RENEW_WHEN_UNDER_DAYS * DAY_MS) return text;

  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const renewed = new Date(midnight + RENEW_TO_DAYS * DAY_MS).toISOString().replace('.000Z', 'Z');
  // Keep the field name and its spacing as found; replace the value only.
  return text.slice(0, match.index) + match[1] + renewed + text.slice(match.index + match[0].length);
}

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {number} the process exit code
 */
function main(argv) {
  if (argv.length > 1) {
    process.stderr.write('usage: renew-security-txt.mjs [path-to-security.txt]\n');
    return 2;
  }
  const file = argv[0] ?? DEFAULT_FILE;
  try {
    const before = readFileSync(file, 'utf8');
    const after = renewExpires(before, new Date());
    if (after === before) {
      process.stdout.write('security.txt: Expires has 30 or more days left, nothing to renew.\n');
      return 0;
    }
    writeFileSync(file, after);
    process.stdout.write(`security.txt: Expires renewed in ${file}.\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`renew-security-txt: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
