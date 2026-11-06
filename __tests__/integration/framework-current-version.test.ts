import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testDb, SEEDED_FRAMEWORK_VERSION_ID } from '../helpers/db';
import assessmentAreas from '../../data/assessmentAreas.json';
import questionBank from '../../data/questionBank.json';

/**
 * The 4.0.0 registry rows and the 4.0.0 content files at data/, which the frozen assessments still pin (SRS 11.3
 * item 7). The 4.0.0 resolvers this file used to drive (readCurrentContentVersion, resolvePublishedVersion,
 * resolveCurrentFramework) are gone with the assessment routes that called them; what stays is what the registry and
 * the files must still agree on, whichever content version is published. Every case reads the database or the files
 * directly, so none depends on 4.0.0 being the published row.
 */

describe('data/assessmentAreas.json and data/questionBank.json agree on meta.version', () => {
  // If these ever diverge, "the 4.0.0 framework" stops having a single meaning. `data/projectConfig.json` carries
  // no `meta` field (and `data/scoringConfig.json` was removed in 0.6.0), so it is not part of this comparison.
  it('declare the same version', () => {
    expect(assessmentAreas.meta.version).toBe('4.0.0');
    expect(questionBank.meta.version).toBe('4.0.0');
  });
});

describe('the seeded framework_versions row and data/assessmentAreas.json agree on version', () => {
  // Both sides are read independently, a JSON import and a Prisma read, so the comparison is of two raw values.
  // The row's status is not read: the 4.0.0 row stays whether it is published or, after content 5.0.0, deprecated.
  it('registry row fv_4_0_0 has the same semver as the content file meta.version', async () => {
    const row = await testDb.frameworkVersion.findUniqueOrThrow({
      where: { id: SEEDED_FRAMEWORK_VERSION_ID },
      select: { semver: true },
    });
    expect(row.semver).toBe(assessmentAreas.meta.version);
  });
});

describe('superseding a content version (ADR-0003)', () => {
  /**
   * The 2026-08-18 content corrections were the first time this registry superseded a version and the 2026-08-27
   * weight flatten (4.0.0) the second; content 5.0.0, registered by CNT's release command, is the third. A published
   * row is immutable and is replaced by a new row plus a `deprecated` marker on the old one, never edited in place.
   * Non-vacuous: an in-place UPDATE of a predecessor's contentHash would leave that row `published` and its successor
   * absent.
   */
  it('leaves the superseded version present but deprecated, not edited or deleted', async () => {
    const rows = await testDb.$queryRaw<Array<{ semver: string; status: string; contentHash: string }>>`
      SELECT "semver", "status", "contentHash" FROM "framework_versions" ORDER BY "semver"`;
    const byVersion = Object.fromEntries(rows.map((r) => [r.semver, r]));

    expect(byVersion['3.0.0']?.status).toBe('deprecated');
    expect(byVersion['3.0.1']?.status).toBe('deprecated');
    // Content 5.0.0's migration, written by CNT's release command (NFR-MNT-07; SRS 11.2), deprecates 4.0.0. Its
    // folder is `<stamp>_content_<semver>`; a bare `_content_` would also match the 3.0.1 folder's name.
    const contentMigrationExists = readdirSync(join(process.cwd(), 'prisma', 'migrations')).some((d) => /^\d{14}_content_/.test(d));
    expect(byVersion['4.0.0']?.status).toBe(contentMigrationExists ? 'deprecated' : 'published');
    expect(byVersion['3.0.0'].contentHash).not.toBe(byVersion['3.0.1'].contentHash);
    expect(byVersion['3.0.1'].contentHash).not.toBe(byVersion['4.0.0'].contentHash);
  });
});
