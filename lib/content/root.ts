import { readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { ContentIndexFile, ContentSemver } from '@/types/content';

/**
 * Where the framework content is read from (ADR-C9, FR-CNT-01). This is the only module under `app/` or
 * `lib/` that reads a content file; the loader asks it for bytes and hashes them itself. Nothing here is
 * computed at import time, so a test can move the root between calls.
 *
 * Production reads `<cwd>/data/content`. A live test server (Playwright, a builder's check) cannot use
 * `vi.mock`, so it can be pointed at the fixture bundle with two variables: `MAKRAI_TEST_SEAMS=1` and
 * `MAKRAI_CONTENT_ROOT=<a directory inside __tests__/fixtures/content>`. The production container is
 * never given either (`__tests__/lint/test-seams.test.ts`, `__tests__/lint/prod-env-completeness.test.ts`),
 * and the seam refuses anything outside the fixture tree, so a stray variable cannot redirect a real server.
 *
 * Build tracing (contract "Static read paths"). Turbopack follows a read whose path it can resolve, and a
 * read through a computed root makes it trace the whole project, which put `.env`, the sources and the
 * fixtures into `.next/standalone`. So the production reads keep a literal prefix after `process.cwd()`,
 * and every other call here, which only runs on the seam branch, hides its computed argument from the
 * tracer with the `turbopackIgnore` directive. `scripts/check-standalone.mjs` checks the result after a build.
 */

/** The seam's accepted root as a real path, or `null` when production reads apply. */
function seamRoot(): string | null {
  // Exactly '1': 'true', '0' and ' 1' do not open the seam.
  if (process.env.MAKRAI_TEST_SEAMS !== '1') return null;
  const requested = process.env.MAKRAI_CONTENT_ROOT;
  if (!requested) return null;
  try {
    // Real paths, so a symlink out of the fixture tree is judged by where it leads.
    const real = realpathSync(/*turbopackIgnore: true*/ requested);
    const fixtures = realpathSync(
      /*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ process.cwd(), '__tests__', 'fixtures', 'content'),
    );
    // The fixture directory itself holds index.json, so it is a root; a sibling such as `content-other`
    // shares the prefix but not the separator.
    return real === fixtures || real.startsWith(fixtures + sep) ? real : null;
  } catch {
    // A path that does not exist, or cannot be read, is not accepted: production reads apply. The production
    // server never sets the flag, and a test server with a wrong path serves the real bundle, which the live
    // check of the fixture content shows.
    return null;
  }
}

/** A semver or file name may not reach outside its directory (H-S10). */
const PATH_LIKE = /[/\\\0]|\.\./;

/** The absolute content root, for scripts and tests. No route calls it. */
export function contentRoot(): string {
  return seamRoot() ?? join(process.cwd(), 'data', 'content');
}

/** The bytes of one file of one content version. */
export function readContentBytes(semver: ContentSemver, file: string): Buffer {
  if (PATH_LIKE.test(semver) || PATH_LIKE.test(file)) throw new Error(`content path refused: ${semver}/${file}`);
  const root = seamRoot();
  if (root !== null) return readFileSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ root, semver, file));
  return readFileSync(join(process.cwd(), 'data', 'content', semver, file));
}

/** The parsed `index.json`: which version is running and which versions the root holds. */
export function readContentIndex(): ContentIndexFile {
  const root = seamRoot();
  const text =
    root !== null
      ? readFileSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ root, 'index.json'), 'utf8')
      : readFileSync(join(process.cwd(), 'data', 'content', 'index.json'), 'utf8');
  return JSON.parse(text) as ContentIndexFile;
}

/** The running content version, read on each call. */
export function runningSemver(): ContentSemver {
  return readContentIndex().running;
}
