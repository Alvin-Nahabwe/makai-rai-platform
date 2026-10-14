import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renewExpires } from '../../scripts/renew-security-txt.mjs';

/**
 * `public/.well-known/security.txt` carries an `Expires` field (RFC 9116 section
 * 2.5.5): a reader treats a file past its date as stale and may ignore it. A date
 * that is only ever moved by hand lapses silently, so a daily CI job calls
 * `renewExpires` and opens a PR when it moved the date (G2-22, G2-10, D-06).
 *
 * The job-shape test (`__tests__/lint/service-parameters.test.ts`) proves the job
 * exists and what it may do. It does not prove the date arithmetic, and a wrong
 * date here fails quietly: the file would still parse, and would simply expire.
 * These tests are that proof. Every instant is a UTC literal, so none depends on
 * the machine's zone or on the clock of the day the suite runs.
 */

const DAY = 86_400_000;

/** `spawnSync` wants a full `ProcessEnv`; a scratch environment is deliberately small. */
const envOf = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;
const TODAY = new Date('2026-10-14T00:00:00Z');
const at = (days: number, from: Date = TODAY) => new Date(from.getTime() + days * DAY).toISOString().replace('.000Z', 'Z');

/** A security.txt whose Expires is `days` after TODAY, with the other fields RFC 9116 asks for. */
const fileExpiring = (days: number) =>
  [
    '# Service parameters: https://makrai.org/service-parameters.json',
    'Contact: mailto:security@makrai.org',
    `Expires: ${at(days)}`,
    'Preferred-Languages: en',
    'Canonical: https://makrai.org/.well-known/security.txt',
    '',
  ].join('\n');

describe('renewExpires leaves a file with 30 or more days left exactly as it is', () => {
  it.each([30, 31, 200, 365])('%i days left: unchanged', (days) => {
    const text = fileExpiring(days);
    expect(renewExpires(text, TODAY)).toBe(text);
  });

  it('is measured to the instant: 30 days to the second is enough, one second short is not', () => {
    const exactly30 = fileExpiring(30);
    expect(renewExpires(exactly30, TODAY)).toBe(exactly30);
    const oneSecondOn = new Date(TODAY.getTime() + 1000); // Expires is then 30 days minus one second away
    expect(renewExpires(exactly30, oneSecondOn)).toBe(fileExpiring(365));
  });
});

describe('renewExpires moves Expires 365 days out when fewer than 30 remain or the date has passed', () => {
  it.each([29, 1, 0, -1, -400])('%i days left: Expires becomes today + 365 days', (days) => {
    const renewed = renewExpires(fileExpiring(days), TODAY);
    expect(renewed).toBe(fileExpiring(365));
    expect(renewed).toContain('Expires: 2027-10-14T00:00:00Z\n');
  });

  it('uses the UTC date of today, at midnight, whatever the time of day', () => {
    const lateEvening = new Date('2026-10-14T23:59:59Z');
    // 365 days from the UTC date, not from the instant: the file never claims more than a year from the day it was renewed.
    expect(renewExpires(fileExpiring(-5), lateEvening)).toContain('Expires: 2027-10-14T00:00:00Z\n');
  });

  // The in-process case above cannot tell UTC getters from local ones when the machine's zone is UTC or west of
  // it, and CI runs in UTC. These run the function in a child process with a fixed zone on each side of UTC, so
  // that swapping getUTCDate for getDate fails here whatever zone the suite itself runs in.
  describe('takes the UTC date, not the machine\u2019s own, in a zone on either side of UTC', () => {
    const MODULE_URL = pathToFileURL(join(__dirname, '../../scripts/renew-security-txt.mjs')).href;
    const probe = `
      import { renewExpires } from ${JSON.stringify(MODULE_URL)};
      const [text, instant] = process.argv.slice(-2);
      const today = new Date(instant);
      process.stdout.write(JSON.stringify({ localDate: today.getDate(), out: renewExpires(text, today) }));
    `;
    const inZone = (tz: string, instant: string) => {
      const r = spawnSync('node', ['--input-type=module', '-e', probe, fileExpiring(-5), instant], {
        encoding: 'utf8',
        env: envOf({ PATH: process.env.PATH ?? '', TZ: tz }),
      });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout) as { localDate: number; out: string };
    };

    it.each([
      // [zone, instant, the local calendar day the zone gives that instant]
      ['Pacific/Kiritimati', '2026-10-14T23:59:59Z', 15], // UTC+14: already the next day
      ['Pacific/Pago_Pago', '2026-10-14T00:00:00Z', 13], // UTC-11: still the day before
      ['UTC', '2026-10-14T12:00:00Z', 14],
    ])('%s at %s', (tz, instant, localDay) => {
      const { localDate, out } = inZone(tz, instant);
      // Not vacuous: the zone took effect, so a local-date implementation would see a different day than UTC does.
      expect(localDate, `TZ=${tz} should be in force in the child`).toBe(localDay);
      expect(out).toContain('Expires: 2027-10-14T00:00:00Z\n');
    });
  });

  it('counts a leap day as a day: 365 days from 2027-10-14 is 2028-10-13', () => {
    const renewed = renewExpires(fileExpiring(-5), new Date('2027-10-14T00:00:00Z'));
    expect(renewed).toContain('Expires: 2028-10-13T00:00:00Z\n');
  });

  it('is idempotent: renewing the same day twice changes nothing the second time', () => {
    const once = renewExpires(fileExpiring(3), TODAY);
    expect(renewExpires(once, TODAY)).toBe(once);
  });

  it('changes the Expires line and nothing else', () => {
    const before = fileExpiring(3).split('\n');
    const after = renewExpires(fileExpiring(3), TODAY).split('\n');
    expect(after).toHaveLength(before.length);
    const differing = before.map((line, i) => (line === after[i] ? null : i)).filter((i) => i !== null);
    expect(differing).toEqual([before.findIndex((l) => l.startsWith('Expires:'))]);
  });

  it('keeps CRLF line endings, which RFC 9116 allows', () => {
    const crlf = fileExpiring(3).replace(/\n/g, '\r\n');
    const renewed = renewExpires(crlf, TODAY);
    expect(renewed).toBe(fileExpiring(365).replace(/\n/g, '\r\n'));
  });

  it('reads the field name case-insensitively, as RFC 9116 does, and writes it back as it found it', () => {
    const renewed = renewExpires('contact: mailto:a@example.org\nexpires: 2026-10-20T00:00:00Z\n', TODAY);
    expect(renewed).toBe('contact: mailto:a@example.org\nexpires: 2027-10-14T00:00:00Z\n');
  });
});

describe('renewExpires fails loudly on a file it cannot read, rather than writing a wrong date', () => {
  it('refuses a file with no Expires field', () => {
    expect(() => renewExpires('Contact: mailto:security@makrai.org\n', TODAY)).toThrow(/no Expires field/);
  });

  it('refuses a file with two Expires fields (RFC 9116: exactly one)', () => {
    const two = `${fileExpiring(3)}Expires: ${at(300)}\n`;
    expect(() => renewExpires(two, TODAY)).toThrow(/more than one Expires field/);
  });

  it.each(['soon', '2026-13-40T00:00:00Z', '2026-10-14', '14 October 2026', ''])('refuses the unreadable date %j', (value) => {
    expect(() => renewExpires(`Contact: mailto:a@example.org\nExpires: ${value}\n`, TODAY)).toThrow(/Expires/);
  });

  it('does not mistake a comment that mentions Expires for the field', () => {
    const text = `# Expires: 2020-01-01T00:00:00Z is the old value\n${fileExpiring(200)}`;
    expect(renewExpires(text, TODAY)).toBe(text);
  });

  it('refuses a today that is not a valid Date', () => {
    expect(() => renewExpires(fileExpiring(3), new Date('not a date'))).toThrow(/today/);
  });
});

describe('the command line rewrites security.txt in place', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const SCRIPT = join(__dirname, '../../scripts/renew-security-txt.mjs');

  /** A scratch copy, so the test never touches the committed file. */
  function scratchWith(text: string): string {
    const dir = mkdtempSync(join(tmpdir(), 't19-renew-'));
    dirs.push(dir);
    const file = join(dir, 'security.txt');
    writeFileSync(file, text);
    return file;
  }
  const run = (file: string) => spawnSync('node', [SCRIPT, file], { encoding: 'utf8' });

  it('renews a lapsed file in place and says so', () => {
    const file = scratchWith(fileExpiring(-10));
    const before = Date.now();
    const result = run(file);
    const after = Date.now();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/renewed/i);
    // The command reads the real clock; either side of a UTC midnight is acceptable.
    const expected = [before, after].map((t) => `Expires: ${at(365, new Date(Math.floor(t / DAY) * DAY))}`);
    expect(expected).toContain(readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('Expires:')));
  });

  it('leaves a file alone, byte for byte, when 30 or more days remain', () => {
    const text = fileExpiring(10_000).replace(at(10_000), '2099-01-01T00:00:00Z');
    const file = scratchWith(text);
    const result = run(file);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/nothing to renew/i);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('exits non-zero and leaves the file untouched when it has no Expires', () => {
    const text = 'Contact: mailto:security@makrai.org\n';
    const file = scratchWith(text);
    const result = run(file);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no Expires field/);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('with no argument, rewrites public/.well-known/security.txt next to the script, wherever it is run from', () => {
    // A scratch tree with the repository's layout: the default path must come from the script's own location,
    // not from the working directory, or the CI step would depend on where it happens to start.
    const root = mkdtempSync(join(tmpdir(), 't19-renew-tree-'));
    dirs.push(root);
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'public/.well-known'), { recursive: true });
    copyFileSync(SCRIPT, join(root, 'scripts/renew-security-txt.mjs'));
    const target = join(root, 'public/.well-known/security.txt');
    writeFileSync(target, fileExpiring(-10));
    const elsewhere = mkdtempSync(join(tmpdir(), 't19-renew-cwd-'));
    dirs.push(elsewhere);
    const result = spawnSync('node', [join(root, 'scripts/renew-security-txt.mjs')], { cwd: elsewhere, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(target, 'utf8')).not.toBe(fileExpiring(-10));
    expect(readFileSync(target, 'utf8')).toMatch(/^Expires: 20\d\d-\d\d-\d\dT00:00:00Z$/m);
  });
});
