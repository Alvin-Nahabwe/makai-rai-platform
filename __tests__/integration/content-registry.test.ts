import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runningContent } from '@/lib/content/loader';
import { contentRefById, resolveRunningContentVersion } from '@/lib/data/framework';
import { createOrgContext, withOrg } from '@/lib/data/tenant';
import { useFixtureContent } from '../helpers/content';
// In the contract's Test harness API, for refusal cases only (R15-12): useFixtureContent takes only a fixture semver and inserts its row, so it cannot name '9.9.9' for the loader-refusal case below.
import { setRunningFixture } from '../setup/content';
import { testDb } from '../helpers/db';
import { captureLogs } from '../helpers/logCapture';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Matching the running content to its published registry row (K-2, SRS line 273) and reading any registered
 * version back (FR-CNT-07). `useFixtureContent` publishes the fixture rows and removes them when the file ends.
 */

const ctx = createOrgContext('org-cnt-registry', 'owner');   // framework_versions has no RLS

afterEach(() => {
  vi.doUnmock('@/lib/framework/bundleHash');
  vi.resetModules();
});

describe('registry lookups', () => {
  it('FR-DEC-02 FR-CNT-01: the running fixture resolves to its published row', async () => {
    const ref = await useFixtureContent('0.0.1-fixture');
    expect(await withOrg(ctx, (tx) => resolveRunningContentVersion(tx))).toEqual(ref);
    expect(ref).toMatchObject({ contentVersionId: 'fv_fixture_0_0_1', semver: '0.0.1-fixture', contentHash: runningContent().contentHash });
  });

  it('FR-DEC-02 K-2: a running bundle whose hash is not published answers 503 content_not_published', async () => {
    await useFixtureContent('0.0.1-fixture');
    for (const change of [{ contentHash: '0'.repeat(64) }, { status: 'deprecated' }]) {
      const before = await testDb.frameworkVersion.findUniqueOrThrow({ where: { id: 'fv_fixture_0_0_1' } });
      await testDb.frameworkVersion.update({ where: { id: before.id }, data: change });
      try {
        await expect(withOrg(ctx, (tx) => resolveRunningContentVersion(tx))).rejects.toMatchObject({ status: 503, code: 'content_not_published' });
      } finally {
        await testDb.frameworkVersion.update({ where: { id: before.id }, data: { contentHash: before.contentHash, status: before.status } });
      }
    }
  });

  it('FR-DEC-02 K-2: a published row that carries the running hash under another semver does not open the gate', async () => {
    await useFixtureContent('0.0.1-fixture');
    const before = await testDb.frameworkVersion.findUniqueOrThrow({ where: { id: 'fv_fixture_0_0_1' } });
    await testDb.frameworkVersion.update({ where: { id: before.id }, data: { semver: '0.0.9-fixture' } });
    try {
      await expect(withOrg(ctx, (tx) => resolveRunningContentVersion(tx))).rejects.toMatchObject({ status: 503, code: 'content_not_published' });
    } finally {
      await testDb.frameworkVersion.update({ where: { id: before.id }, data: { semver: before.semver } });
    }
  });

  it('FR-DEC-02 NFR-SEC-11: the refusal says only its code, so a response carries no hash or version', async () => {
    await useFixtureContent('0.0.1-fixture');
    await testDb.frameworkVersion.update({ where: { id: 'fv_fixture_0_0_1' }, data: { status: 'deprecated' } });
    try {
      const error = await withOrg(ctx, (tx) => resolveRunningContentVersion(tx)).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 503, code: 'content_not_published', message: 'content_not_published' });
    } finally {
      await testDb.frameworkVersion.update({ where: { id: 'fv_fixture_0_0_1' }, data: { status: 'published' } });
    }
  });

  it('FR-DEC-02 NFR-OBS-05: a 503 content_not_published logs one REQUEST_FAILED line carrying the reference of its body', async () => {
    // Every save answers this when the running hash has no published row (K-2), so the operator must find it in the log.
    await useFixtureContent('0.0.1-fixture');
    await testDb.frameworkVersion.update({ where: { id: 'fv_fixture_0_0_1' }, data: { status: 'deprecated' } });
    try {
      const error = await withOrg(ctx, (tx) => resolveRunningContentVersion(tx)).catch((e: unknown) => e);
      const { result: response, lines } = await captureLogs(async () => toResponse(error));
      const body = (await response.json()) as { code: string; reference: string };
      expect(response.status).toBe(503);
      expect(body.code).toBe('content_not_published');
      expect(body.reference).toMatch(/\S/);
      const failed = lines.filter((l) => l.includes('REQUEST_FAILED')).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(failed).toEqual([expect.objectContaining({ event: 'REQUEST_FAILED', reference: body.reference, status: 503, code: 'content_not_published' })]);
    } finally {
      await testDb.frameworkVersion.update({ where: { id: 'fv_fixture_0_0_1' }, data: { status: 'published' } });
    }
  });

  it('FR-DEC-02 K-2: a running version the loader cannot load is not reported as unpublished', async () => {
    await useFixtureContent('0.0.1-fixture');
    setRunningFixture('9.9.9');   // index.json lists no such version
    try {
      await expect(withOrg(ctx, (tx) => resolveRunningContentVersion(tx))).rejects.toMatchObject({ status: 500, code: 'unknown_content_version' });
    } finally {
      await useFixtureContent('0.0.1-fixture');
    }
  });

  it('FR-CNT-07: contentRefById reads any registered version, also a deprecated one', async () => {
    const old = await useFixtureContent('0.0.1-fixture'); await useFixtureContent('0.0.2-fixture');
    expect(await withOrg(ctx, (tx) => contentRefById(tx, old.contentVersionId))).toEqual(old);
    await expect(withOrg(ctx, (tx) => contentRefById(tx, 'fv_none'))).rejects.toMatchObject({ status: 500, code: 'unknown_content_version' });
    await testDb.frameworkVersion.update({ where: { id: old.contentVersionId }, data: { status: 'deprecated' } });
    try {
      expect(await withOrg(ctx, (tx) => contentRefById(tx, old.contentVersionId))).toEqual(old);
    } finally {
      await testDb.frameworkVersion.update({ where: { id: old.contentVersionId }, data: { status: 'published' } });
    }
  });

  it('FR-CNT-07 NFR-SEC-11: contentRefById answers a hostile or empty id with unknown_content_version and its code alone', async () => {
    for (const id of ["fv_fixture_0_0_1'; DROP TABLE framework_versions; --", '', '../fv_fixture_0_0_1', '%']) {
      const error = await withOrg(ctx, (tx) => contentRefById(tx, id)).catch((e: unknown) => e);
      expect(error, JSON.stringify(id)).toMatchObject({ status: 500, code: 'unknown_content_version', message: 'unknown_content_version' });
    }
  });
});

describe('the 4.0.0 resolvers are gone', () => {
  it('FR-CNT-07: importing lib/data/framework.ts computes no hash', async () => {
    const calls = { n: 0 };
    vi.doMock('@/lib/framework/bundleHash', async (orig) => ({ ...(await orig<object>()), computeBundleHash: () => { calls.n++; return 'x'; } }));
    vi.resetModules(); await import('@/lib/data/framework');
    expect(calls.n).toBe(0);
  });

  it('FR-CNT-07 FR-RM-01: lib/data/framework.ts holds only the content registry lookups and reads no 4.0.0 file, so lib/framework/bundleHash.ts can be deleted', async () => {
    // RM's second pull request deletes lib/framework/bundleHash.ts and data/scoringConfig.json whole once nothing calls
    // computeBundleHash; no route, page or library called the 4.0.0 resolvers after RM removed the assessment routes.
    const src = readFileSync('lib/data/framework.ts', 'utf8');
    expect(src).not.toMatch(/@\/lib\/framework\/bundleHash|computeBundleHash|@\/data\/[A-Za-z]+\.json/);
    vi.resetModules();
    expect(Object.keys(await import('@/lib/data/framework')).sort()).toEqual(['contentRefById', 'resolveRunningContentVersion']);
  });
});

