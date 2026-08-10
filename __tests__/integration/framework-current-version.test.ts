import { beforeEach, describe, expect, it } from 'vitest';
import {
  testDb,
  resetDb,
  SEEDED_FRAMEWORK_VERSION_ID,
  withDriftedFrameworkContent,
} from '../helpers/db';
import { withOrg, createOrgContext } from '../../lib/data/tenant';
import {
  resolveCurrentFramework,
  readCurrentContentVersion,
  resolvePublishedVersion,
} from '../../lib/data/framework';
import assessmentAreas from '../../data/assessmentAreas.json';
import questionBank from '../../data/questionBank.json';

/**
 * Fix round 1 (coordinator-authorised Task 1 scope extension, 2026-08-07):
 * the plan enumerated every reader of the pin and never asked which file
 * WRITES it, so `POST .../assessments` created an Assessment with no
 * `frameworkVersionId` at all. `resolveCurrentFramework` is the resolver that
 * closes that gap -- the write half of the column Task 1 introduced.
 *
 * `readCurrentContentVersion`/`resolvePublishedVersion` are exported
 * alongside `resolveCurrentFramework` (not requested by name, but a
 * deliberate decomposition): `resolveCurrentFramework` takes only a `tx`
 * and always reads the real content file, so its own "no fallback, throw
 * loudly" path cannot be exercised without either mutating
 * `data/assessmentAreas.json` on disk (risky -- a crashed test run could
 * leave it corrupted) or module-mocking `node:fs` (brittle under ESM).
 * Splitting the DB lookup into `resolvePublishedVersion(semver, tx)` makes
 * the throw path directly and robustly testable with a semver that can
 * never collide with real content, while `resolveCurrentFramework` itself
 * is still proven end-to-end against the real file in the last describe
 * block below.
 *
 * C6 whole-branch review, F5 (2026-08-09): `getCurrentVersionId` became
 * `resolveCurrentFramework` and now returns `{ pinned, matches }` rather
 * than a bare id, so creation can refuse a pin the deployed content no
 * longer matches. `resolvePublishedVersionId` became
 * `resolvePublishedVersion` and returns the whole row for the same reason.
 * The old names are gone rather than kept as aliases -- an alias would be
 * an export with no production caller, which is the very defect class this
 * review round is closing.
 *
 * Fix round 2 (2026-08-08): the content-agreement block below now calls
 * `readCurrentContentVersion()` instead of re-importing the JSON, and a new
 * block asserts the seeded registry row and the content file agree on
 * version directly (closing a latent drift risk in the exact-string match
 * `resolvePublishedVersionId` performs -- see that block's own comment).
 */

async function seedOrg(slug: string) {
  return testDb.organization.create({ data: { name: slug, slug } });
}

describe('readCurrentContentVersion', () => {
  it('reads meta.version from data/assessmentAreas.json', () => {
    expect(readCurrentContentVersion()).toBe('3.0.0');
  });
});

describe('data/assessmentAreas.json and data/questionBank.json agree on meta.version', () => {
  // Coordinator-specified check: if these ever diverge, "the framework
  // version" stops having a single meaning and must fail loudly rather than
  // resolve arbitrarily to whichever file the code happens to read.
  // `data/projectConfig.json` and `data/scoringConfig.json` carry no `meta`
  // field at all -- verified live (fix round 2, 2026-08-08):
  //   $ node -e "const p=require('./data/projectConfig.json'), s=require('./data/scoringConfig.json'); console.log('meta' in p, 'meta' in s);"
  //   false false
  // -- so they are not part of this comparison.
  //
  // Fix round 2: uses readCurrentContentVersion() for the assessmentAreas
  // side instead of a second raw import of the same JSON file. This is
  // the reuse framework.ts's own doc comment on readCurrentContentVersion
  // claims -- fix round 1 wrote that claim before any call site of it
  // existed (a defect the coordinator caught: a comment describing a
  // relationship the code did not have). Making the call site real here
  // is how that claim became true, rather than deleting the sentence.
  it('declare the same version', () => {
    expect(readCurrentContentVersion()).toBe('3.0.0');
    expect(questionBank.meta.version).toBe('3.0.0');
    expect(questionBank.meta.version).toBe(readCurrentContentVersion());
  });
});

describe('the seeded framework_versions row and data/assessmentAreas.json agree on version', () => {
  // Item 3, fix round 2 (2026-08-08). `resolvePublishedVersionId`
  // (lib/data/framework.ts) matches `framework_versions.semver` against
  // `data/assessmentAreas.json`'s `meta.version` by EXACT string equality
  // (`where: { semver, status: 'published' }`). The two are independently
  // maintained -- one in this migration's INSERT, the other in a content
  // file a domain author edits -- and agree today only because nobody has
  // bumped either since the migration ran. The production change this
  // test is named to catch: someone bumps meta.version (e.g. to '3.1.0')
  // without adding/publishing a framework_versions row carrying the
  // identical semver, or adds one with a typo ('3.1' vs '3.1.0'). NO
  // normalisation or fuzzy matching is added here on purpose -- these two
  // values are supposed to be identical BY CONSTRUCTION, and tolerating a
  // difference would hide the drift this test exists to surface. Both
  // sides are read independently of any lib/data/framework.ts function --
  // a direct JSON import, a direct Prisma read -- rather than through
  // resolvePublishedVersion/resolveCurrentFramework, so this compares two
  // raw, independently-obtained values instead of re-deriving one side
  // from code whose own correctness depends on them already agreeing.
  //
  // HONEST LIMIT: this repository has no CI (verified live: no
  // .github/workflows, .gitlab-ci.yml, .circleci, or Jenkinsfile exist;
  // docker/Dockerfile's builder stage runs only `npm run build`, never
  // `npm run verify` or `vitest`). This test is therefore not an
  // automatic gate -- it fires only when a human runs the suite. The CI
  // gap itself is tracked separately (register row D-146), not this
  // test's to fix.
  it('registry row fv_3_0_0 has the same semver as the content file meta.version', async () => {
    const row = await testDb.frameworkVersion.findUniqueOrThrow({
      where: { id: SEEDED_FRAMEWORK_VERSION_ID },
      select: { semver: true },
    });
    expect(row.semver).toBe(assessmentAreas.meta.version);
  });
});

describe('resolvePublishedVersion', () => {
  beforeEach(resetDb);

  it('resolves the registry row for a published semver, carrying the contentHash creation needs', async () => {
    const org = await seedOrg('fw-cur-resolve-a');
    const ctx = createOrgContext(org.id, 'owner');
    const seeded = await testDb.frameworkVersion.findUniqueOrThrow({
      where: { id: SEEDED_FRAMEWORK_VERSION_ID },
      select: { contentHash: true },
    });
    const row = await withOrg(ctx, (tx) => resolvePublishedVersion('3.0.0', tx));
    expect(row).toEqual({ id: 'fv_3_0_0', semver: '3.0.0', contentHash: seeded.contentHash });
  });

  it('throws when no published row matches the semver -- no fallback (AGENTS.md §2)', async () => {
    const org = await seedOrg('fw-cur-resolve-b');
    const ctx = createOrgContext(org.id, 'owner');
    await expect(
      withOrg(ctx, (tx) => resolvePublishedVersion('definitely-not-a-real-semver-9.9.9', tx)),
    ).rejects.toThrow(/no published framework_versions row/i);
  });
});

describe('resolveCurrentFramework (C6 F5)', () => {
  beforeEach(resetDb);

  it('resolves the CURRENT content version to its registry row and reports matches: true', async () => {
    const org = await seedOrg('fw-cur-current');
    const ctx = createOrgContext(org.id, 'owner');
    const resolution = await withOrg(ctx, (tx) => resolveCurrentFramework(tx));
    expect(resolution.pinned.id).toBe('fv_3_0_0');
    expect(resolution.matches).toBe(true);
  });

  /**
   * The claim: `matches` is computed from the row's `contentHash` against
   * the running bundle, NOT from the semver having resolved. Non-vacuous
   * against the pre-fix behaviour, which had no `matches` at all and would
   * have returned the same id here as in the case above.
   */
  it('reports matches: false when the registry row hash no longer describes the deployed bundle', async () => {
    const org = await seedOrg('fw-cur-drift');
    const ctx = createOrgContext(org.id, 'owner');
    // Shared helper (`__tests__/helpers/db.ts`) rather than a second copy of
    // the mutate-run-restore block -- it owns the `finally` that keeps the
    // seeded row from leaking into every later test in the run.
    await withDriftedFrameworkContent(async () => {
      const resolution = await withOrg(ctx, (tx) => resolveCurrentFramework(tx));
      expect(resolution.pinned.id).toBe('fv_3_0_0');
      expect(resolution.matches).toBe(false);
    });
  });
});
