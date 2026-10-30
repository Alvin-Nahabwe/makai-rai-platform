import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import type * as RealRoot from '@/lib/content/root';
import type { ContentIndexFile, ContentSemver } from '@/types/content';

/**
 * Vitest setup file (registered in vitest.config.ts) for every test file. It replaces `lib/content/root.ts`,
 * the module every content read goes through, with one that reads the fixture bundle under
 * `__tests__/fixtures/content`. A test that names a question id therefore runs on a bundle that holds that
 * id, never on the real 5.0.0 content, so it does not depend on which ids the question-set revision keeps
 * (G-17).
 *
 * The running version is the one mutable thing. It starts as `0.0.1-fixture` in each test file (each file
 * gets its own copy of this module) and stays where a test puts it for the rest of that file: switch it
 * with `useFixtureContent` from `__tests__/helpers/content.ts`, which also publishes the database row.
 *
 * A test that needs the real module, such as `__tests__/lint/test-seams.test.ts`, starts with
 * `vi.unmock('@/lib/content/root')`.
 */

const state = vi.hoisted(() => ({ running: '0.0.1-fixture' as string }));

/** Sets the running version of the mocked content root. Call `useFixtureContent` instead. */
export function setRunningFixture(semver: ContentSemver): void {
  state.running = semver;
}

vi.mock('@/lib/content/root', () => {
  const root = join(process.cwd(), '__tests__', 'fixtures', 'content');
  // The same refusal as the real module (H-S10), so a test cannot pass on a path the real one rejects.
  const pathLike = /[/\\\0]|\.\./;
  const fixtureRoot: typeof RealRoot = {
    contentRoot: () => root,
    readContentBytes: (semver, file) => {
      if (pathLike.test(semver) || pathLike.test(file)) throw new Error(`content path refused: ${semver}/${file}`);
      return readFileSync(join(root, semver, file));
    },
    // index.json names 0.0.1-fixture as running; the mutable value wins, as the real module's `running` is the
    // one source of the running version.
    readContentIndex: () => ({ ...(JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as ContentIndexFile), running: state.running }),
    runningSemver: () => state.running,
  };
  return fixtureRoot;
});
