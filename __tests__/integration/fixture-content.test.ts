import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeVersionBundleHash } from '@/lib/content/bundleHash';
import { runningSemver } from '@/lib/content/root';
import { testDb, resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';

/**
 * G-17 (unit H0). `useFixtureContent` makes a fixture content version the running one and puts its
 * `framework_versions` row in the database, so a decision can be recorded against it.
 */
describe('useFixtureContent', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('G-17: useFixtureContent publishes the fixture row idempotently after resetDb', async () => {
    await resetDb();
    const a = await useFixtureContent('0.0.2-fixture');
    const b = await useFixtureContent('0.0.2-fixture');
    expect(a).toEqual(b);
    expect(a).toEqual({
      contentVersionId: 'fv_fixture_0_0_2',
      semver: '0.0.2-fixture',
      contentHash: computeVersionBundleHash('__tests__/fixtures/content/0.0.2-fixture'),
    });
    expect(runningSemver()).toBe('0.0.2-fixture');
    expect(await testDb.frameworkVersion.count({ where: { id: 'fv_fixture_0_0_2', status: 'published' } })).toBe(1);
  });

  it('G-17: both fixture versions have their own row, and switching back restores the default running version', async () => {
    const one = await useFixtureContent('0.0.1-fixture');
    const two = await useFixtureContent('0.0.2-fixture');
    expect(one.contentVersionId).toBe('fv_fixture_0_0_1');
    expect(two.contentVersionId).toBe('fv_fixture_0_0_2');
    expect(one.contentHash).not.toBe(two.contentHash);
    await useFixtureContent('0.0.1-fixture');
    expect(runningSemver()).toBe('0.0.1-fixture');
    const rows = await testDb.frameworkVersion.findMany({ where: { id: { startsWith: 'fv_fixture_' } }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.id, r.semver, r.status, r.contentHash])).toEqual([
      ['fv_fixture_0_0_1', '0.0.1-fixture', 'published', one.contentHash],
      ['fv_fixture_0_0_2', '0.0.2-fixture', 'published', two.contentHash],
    ]);
  });

  it('G-17: a stale row is brought back to the current hash and status', async () => {
    await testDb.frameworkVersion.upsert({
      where: { id: 'fv_fixture_0_0_1' },
      create: { id: 'fv_fixture_0_0_1', semver: '0.0.1-fixture', contentHash: 'stale', publishedAt: new Date('2026-01-01T00:00:00Z'), status: 'deprecated' },
      update: { contentHash: 'stale', status: 'deprecated' },
    });
    const ref = await useFixtureContent('0.0.1-fixture');
    const row = await testDb.frameworkVersion.findUniqueOrThrow({ where: { id: 'fv_fixture_0_0_1' } });
    expect([row.contentHash, row.status]).toEqual([ref.contentHash, 'published']);
  });
});

/**
 * G-17, NFR-SEC-17 (unit H0). `scripts/test-db/fixture-content.mjs` publishes the two fixture `framework_versions`
 * rows into the database named by `DATABASE_URL`, for a live test server that cannot use `useFixtureContent`. It
 * writes to a database, so it refuses before it connects unless the seam flag is set and the host is local.
 */
describe('scripts/test-db/fixture-content.mjs', () => {
  const SCRIPT = 'scripts/test-db/fixture-content.mjs';
  const FIXTURE_ROW = { startsWith: 'fv_fixture_' };
  // The child's text is matched, so it runs without colour and any escape that still arrives is removed.
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

  /** `NodeJS.ProcessEnv` requires NODE_ENV under this project's types; a child here is given only what it is named. */
  const childEnv = (env: Record<string, string>) => env as NodeJS.ProcessEnv;

  /** Runs the script with exactly the given variables (and PATH), so nothing the test process holds leaks in. */
  function run(env: Record<string, string>) {
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      env: childEnv({ PATH: process.env.PATH ?? '', NO_COLOR: '1', ...env }),
    });
    return { status: r.status, stdout: (r.stdout ?? '').replace(ANSI, ''), stderr: (r.stderr ?? '').replace(ANSI, '') };
  }
  const target = () => process.env.DATABASE_URL as string; // the test database, set by vitest.config.ts

  beforeEach(async () => {
    await testDb.frameworkVersion.deleteMany({ where: { id: FIXTURE_ROW } });
  });
  afterEach(async () => {
    await testDb.frameworkVersion.deleteMany({ where: { id: FIXTURE_ROW } });
  });

  it('G-17: fixture-content upserts both fixture rows into the given database, twice without change', async () => {
    for (let i = 0; i < 2; i++) {
      const r = run({ DATABASE_URL: target(), MAKRAI_TEST_SEAMS: '1' });
      expect(r.status, r.stderr).toBe(0);
    }
    const rows = await testDb.frameworkVersion.findMany({ where: { id: FIXTURE_ROW }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.id, r.semver, r.status])).toEqual([
      ['fv_fixture_0_0_1', '0.0.1-fixture', 'published'],
      ['fv_fixture_0_0_2', '0.0.2-fixture', 'published'],
    ]);
    // The hash is the one useFixtureContent and the live loader compute, so a save pins the same version either way.
    expect(rows.map((r) => r.contentHash)).toEqual([
      computeVersionBundleHash('__tests__/fixtures/content/0.0.1-fixture'),
      computeVersionBundleHash('__tests__/fixtures/content/0.0.2-fixture'),
    ]);
  });

  it('G-17: fixture-content brings a stale row back to the current hash and status and touches no other registry row', async () => {
    const others = await testDb.frameworkVersion.count({ where: { NOT: { id: FIXTURE_ROW } } });
    await testDb.frameworkVersion.create({
      data: { id: 'fv_fixture_0_0_1', semver: '0.0.1-fixture', contentHash: 'stale', publishedAt: new Date('2026-01-01T00:00:00Z'), status: 'deprecated' },
    });
    expect(run({ DATABASE_URL: target(), MAKRAI_TEST_SEAMS: '1' }).status).toBe(0);
    const row = await testDb.frameworkVersion.findUniqueOrThrow({ where: { id: 'fv_fixture_0_0_1' } });
    expect([row.status, row.contentHash]).toEqual(['published', computeVersionBundleHash('__tests__/fixtures/content/0.0.1-fixture')]);
    expect(await testDb.frameworkVersion.count({ where: { NOT: { id: FIXTURE_ROW } } })).toBe(others);
  });

  it('NFR-SEC-17 G-17: fixture-content refuses a non-local database or a missing seam flag before connecting', async () => {
    const countBefore = await testDb.frameworkVersion.count({ where: { id: FIXTURE_ROW } });
    const remote = run({ DATABASE_URL: 'postgresql://u:s3cr3tpw@db.example.org:5432/makrai', MAKRAI_TEST_SEAMS: '1' });
    expect(remote.status).toBe(1);
    expect(remote.stderr).toMatch(/only localhost or 127\.0\.0\.1/);
    const noFlag = run({ DATABASE_URL: target() });
    expect(noFlag.status).toBe(1);
    expect(noFlag.stderr).toMatch(/MAKRAI_TEST_SEAMS=1/);
    expect(await testDb.frameworkVersion.count({ where: { id: FIXTURE_ROW } })).toBe(countBefore); // neither run wrote

    // Before connecting: a local address that nothing listens on gets the refusal, not a connection error, so the
    // judgement did not wait for a connection. The same holds for a remote host that would not resolve.
    const closed = run({ DATABASE_URL: 'postgresql://u:s3cr3tpw@127.0.0.1:1/makrai' });
    expect(closed.stderr).toMatch(/MAKRAI_TEST_SEAMS=1/);
    expect(closed.stderr).not.toMatch(/ECONNREFUSED/);
    expect(remote.stderr).not.toMatch(/ENOTFOUND|EAI_AGAIN/);
    for (const r of [remote, noFlag, closed]) expect(`${r.stdout}${r.stderr}`).not.toContain('s3cr3tpw'); // the password is never printed
  });

  it('NFR-SEC-17 G-17: only the parsed host decides, only the exact flag value opens it, and a query string cannot name another host', async () => {
    const refused: Array<[string, Record<string, string>]> = [
      ['a longer name', { DATABASE_URL: 'postgresql://u:p@localhost.example.org/makrai', MAKRAI_TEST_SEAMS: '1' }],
      ['userinfo naming localhost', { DATABASE_URL: 'postgresql://localhost:p@db.example.org/makrai', MAKRAI_TEST_SEAMS: '1' }],
      ['a host in the query', { DATABASE_URL: 'postgresql://u:p@localhost/makrai?host=db.example.org', MAKRAI_TEST_SEAMS: '1' }],
      ['hostaddr in the query', { DATABASE_URL: 'postgresql://u:p@localhost/makrai?hostaddr=203.0.113.9', MAKRAI_TEST_SEAMS: '1' }],
      ['a second host', { DATABASE_URL: 'postgresql://localhost,db.example.org/makrai', MAKRAI_TEST_SEAMS: '1' }],
      ['an IPv6 loopback', { DATABASE_URL: 'postgresql://u:p@[::1]:5432/makrai', MAKRAI_TEST_SEAMS: '1' }],
      ['no host', { DATABASE_URL: 'postgresql:///makrai', MAKRAI_TEST_SEAMS: '1' }],
      ['no URL', { MAKRAI_TEST_SEAMS: '1' }],
      ['not a URL', { DATABASE_URL: 'not a url', MAKRAI_TEST_SEAMS: '1' }],
      ['flag true', { DATABASE_URL: target(), MAKRAI_TEST_SEAMS: 'true' }],
      ['flag 0', { DATABASE_URL: target(), MAKRAI_TEST_SEAMS: '0' }],
      ['flag empty', { DATABASE_URL: target(), MAKRAI_TEST_SEAMS: '' }],
    ];
    for (const [why, env] of refused) {
      const r = run(env);
      expect(r.status, `${why}: ${r.stderr}`).toBe(1);
      expect(r.stderr, why).toMatch(/^fixture-content: refused: /m);
    }
    expect(await testDb.frameworkVersion.count({ where: { id: FIXTURE_ROW } })).toBe(0);
  });

  it('G-17: a database that cannot be reached is a failure with a reason and no password, and writes nothing', () => {
    const r = run({ DATABASE_URL: 'postgresql://u:s3cr3tpw@127.0.0.1:1/makrai', MAKRAI_TEST_SEAMS: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^fixture-content: /m);
    expect(`${r.stdout}${r.stderr}`).not.toContain('s3cr3tpw');
  });
});
