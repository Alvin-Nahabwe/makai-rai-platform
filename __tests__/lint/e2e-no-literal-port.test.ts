import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

/**
 * H-S7 and H-S9 (00-master.md E2). Every address a Playwright file uses comes
 * from the configured `baseURL`, which comes from E2E_PORT. A literal port in
 * a spec would send that spec to whichever server owns the port, which on a
 * shared machine can be another builder's.
 */

/** A loopback host spelled with a port: `localhost:3000`, `127.0.0.1:3000`, `[::1]:3000`. */
const LITERAL_PORT = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+/i;

/**
 * Every script file under `dir`, dot-directories included: Playwright collects
 * a spec from any directory that is not gitignored, and `e2e/fixtures/.auth/`
 * (which does hold the live port, in saved sessions) holds only `.json`.
 */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : [];
  });
}

it('NFR-MNT-03 (harness): no e2e file names a literal port', () => {
  // The pattern must recognise each spelling, or the scan below could pass for nothing.
  for (const bad of ['http://localhost:3000', 'LOCALHOST:3000', '127.0.0.1:3103', '0.0.0.0:3000', 'http://[::1]:3000/']) {
    expect(bad, bad).toMatch(LITERAL_PORT);
  }
  const files = filesUnder('e2e').filter((f) => f !== 'e2e/helpers/port.ts');
  expect(files.length, 'the scan found no e2e files, so it would pass for nothing').toBeGreaterThan(5);
  for (const f of files) {
    expect(readFileSync(f, 'utf8'), f).not.toMatch(LITERAL_PORT);
  }
});

it('NFR-PRIV-03 (harness): the server log path is gitignored', () => {
  expect(readFileSync('.gitignore', 'utf8')).toMatch(/^\/test-results\/$/m);
  // The line above can be undone by a later negation; git's own answer cannot.
  // `git check-ignore -q` exits 0 when the path is ignored and 1 when it is not
  // (execFileSync throws on 1).
  expect(() => execFileSync('git', ['check-ignore', '-q', 'test-results/server.log'])).not.toThrow();
});
