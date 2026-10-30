import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { testDb } from '../helpers/db';

/**
 * G-17 (unit H0). `useFixtureContent` publishes `framework_versions` rows, which `resetDb()` keeps, and
 * `framework-registry.test.ts` fails on a row no migration inserted. The helper therefore removes the rows it
 * published when its test file ends. Only a second vitest process can see the database after a file's
 * `afterAll`, so this test runs `fixture-content-cleanup-child.test.ts` that way.
 */
it('G-17: a file that calls useFixtureContent leaves no fv_fixture_ row after its afterAll, even with an assessment pinned to one', async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST'))) as NodeJS.ProcessEnv;
  const child = spawnSync('npx', ['vitest', 'run', '__tests__/integration/fixture-content-cleanup-child.test.ts'], {
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const output = `${child.stdout}\n${child.stderr}`;
  expect(child.status, output).toBe(0);
  expect(output, 'the child file ran its test').toMatch(/Tests\s+1 passed \(1\)/);
  expect(await testDb.frameworkVersion.count({ where: { id: { startsWith: 'fv_fixture_' } } })).toBe(0);
  expect(await testDb.assessment.count()).toBe(0); // the records were cleared first, as resetDb does
}, 150_000);
