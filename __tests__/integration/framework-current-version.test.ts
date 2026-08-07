import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import { withOrg, createOrgContext } from '../../lib/data/tenant';
import {
  getCurrentVersionId,
  readCurrentContentVersion,
  resolvePublishedVersionId,
} from '../../lib/data/framework';
import assessmentAreas from '../../data/assessmentAreas.json';
import questionBank from '../../data/questionBank.json';

/**
 * Fix round 1 (coordinator-authorised Task 1 scope extension, 2026-08-07):
 * the plan enumerated every reader of the pin and never asked which file
 * WRITES it, so `POST .../assessments` created an Assessment with no
 * `frameworkVersionId` at all. `getCurrentVersionId` is the resolver that
 * closes that gap -- the write half of the column Task 1 introduced.
 *
 * `readCurrentContentVersion`/`resolvePublishedVersionId` are exported
 * alongside `getCurrentVersionId` (not requested by name, but a deliberate
 * decomposition): `getCurrentVersionId` takes no parameters and always
 * reads the real content file, so its own "no fallback, throw loudly" path
 * cannot be exercised without either mutating `data/assessmentAreas.json`
 * on disk (risky -- a crashed test run could leave it corrupted) or module
 * -mocking `node:fs` (brittle under ESM). Splitting the DB lookup into
 * `resolvePublishedVersionId(semver, tx)` makes the throw path directly and
 * robustly testable with a semver that can never collide with real content,
 * while `getCurrentVersionId` itself is still proven end-to-end against the
 * real file in the last describe block below.
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
  // field at all (verified live), so are not part of this comparison.
  it('declare the same version', () => {
    expect(assessmentAreas.meta.version).toBe('3.0.0');
    expect(questionBank.meta.version).toBe('3.0.0');
    expect(questionBank.meta.version).toBe(assessmentAreas.meta.version);
  });
});

describe('resolvePublishedVersionId', () => {
  beforeEach(resetDb);

  it('resolves the registry row id for a published semver', async () => {
    const org = await seedOrg('fw-cur-resolve-a');
    const ctx = createOrgContext(org.id, 'owner');
    const id = await withOrg(ctx, (tx) => resolvePublishedVersionId('3.0.0', tx));
    expect(id).toBe('fv_3_0_0');
  });

  it('throws when no published row matches the semver -- no fallback (AGENTS.md §2)', async () => {
    const org = await seedOrg('fw-cur-resolve-b');
    const ctx = createOrgContext(org.id, 'owner');
    await expect(
      withOrg(ctx, (tx) => resolvePublishedVersionId('definitely-not-a-real-semver-9.9.9', tx)),
    ).rejects.toThrow(/no published framework_versions row/i);
  });
});

describe('getCurrentVersionId', () => {
  beforeEach(resetDb);

  it('resolves the CURRENT content version to its registry row id', async () => {
    const org = await seedOrg('fw-cur-current');
    const ctx = createOrgContext(org.id, 'owner');
    const id = await withOrg(ctx, (tx) => getCurrentVersionId(tx));
    expect(id).toBe('fv_3_0_0');
  });
});
