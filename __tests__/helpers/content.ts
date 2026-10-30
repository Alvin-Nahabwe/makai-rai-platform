import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentRef } from '@/types/api';
import type { QuestionBankFile } from '@/types/content';
import { computeVersionBundleHash } from '@/lib/content/bundleHash';
import { rememberFixtureRow, setRunningFixture } from '../setup/content';
import { testDb } from './db';

/**
 * The fixture content bundle's side of the test harness (G-17). `useFixtureContent` makes one of the two
 * fixture versions the running content version and publishes its `framework_versions` row, so a decision
 * can be recorded against it. `computeVersionBundleHash` is for scripts and tests only; nothing under
 * `app/` or `lib/` imports it.
 *
 * The rows are removed when the test file ends (the `afterAll` in `__tests__/setup/content.ts`), so a caller
 * has nothing to clean up.
 */

export type FixtureSemver = '0.0.1-fixture' | '0.0.2-fixture';

const FIXTURE_ROOT = join(process.cwd(), '__tests__', 'fixtures', 'content');
const ROW_ID: Record<FixtureSemver, string> = {
  '0.0.1-fixture': 'fv_fixture_0_0_1',
  '0.0.2-fixture': 'fv_fixture_0_0_2',
};
const PUBLISHED_AT = new Date('2026-10-30T00:00:00Z');

/** The 78 question ids of v0.5.0, which both fixture versions hold, in file order. */
export const FIXTURE_QUESTION_IDS: readonly string[] = Object.values(
  (JSON.parse(readFileSync(join(FIXTURE_ROOT, '0.0.1-fixture', 'questionBank.json'), 'utf8')) as QuestionBankFile).stages,
)
  .flatMap((stage) => stage.modules)
  .flatMap((module) => module.questions)
  .map((question) => question.id);

/**
 * Sets the running content version and upserts its registry row, published, with the hash of its files.
 * Idempotent, and safe after `resetDb()`, which keeps `framework_versions`. The row is deleted after the last
 * test of the file.
 */
export async function useFixtureContent(semver: FixtureSemver): Promise<ContentRef> {
  setRunningFixture(semver);
  const id = ROW_ID[semver];
  rememberFixtureRow(id);
  const contentHash = computeVersionBundleHash(join(FIXTURE_ROOT, semver));
  await testDb.frameworkVersion.upsert({
    where: { id },
    create: { id, semver, contentHash, publishedAt: PUBLISHED_AT, status: 'published' },
    update: { semver, contentHash, status: 'published' },
  });
  return { contentVersionId: id, semver, contentHash };
}
