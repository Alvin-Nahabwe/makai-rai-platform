import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';

/**
 * FR-RES-01: no page offers a research-consent control. The pages half of the guard (the source
 * half is __tests__/lint/no-research-consent.test.ts, the database half is
 * __tests__/integration/research-ready.test.ts).
 *
 * The route list is asked of git, not written here, so a page a later unit adds is crawled as soon
 * as it is committed. Route groups `(name)` are not part of a URL. A page with a dynamic segment
 * other than `[slug]` has no URL this spec can know, so it is left to the live crawl on the
 * candidate build.
 *
 * Each route is opened signed out and as a fixture owner. A control that only a signed-in user is
 * shown is found by the second pass; a page that sends a signed-out visitor to /login is checked
 * through the page it lands on.
 */
const routes = execFileSync('git', ['ls-files', 'app/*page.tsx'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .map(
    (f) =>
      '/' +
      f
        .replace(/^app\//, '')
        .replace(/\/?page\.tsx$/, '')
        .split('/')
        .filter((s) => !/^\(.*\)$/.test(s))
        .join('/'),
  )
  .filter((r) => !/\[(?!slug\])/.test(r));

/** Read when a test runs, not when the file loads: the `setup` project writes the manifest first. */
function owner(): FixtureManifestUser {
  const manifest: FixtureManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  const found = manifest.users.find((u) => u.role === 'owner');
  if (!found) throw new Error('no-research-consent: the fixture manifest holds no owner');
  return found;
}

for (const signedIn of [false, true]) {
  for (const route of routes) {
    test(`FR-RES-01: no page offers a research-consent control: ${route} ${signedIn ? 'owner' : 'signed out'}`, async ({
      browser,
    }) => {
      const who = owner();
      const ctx = await browser.newContext(signedIn ? { storageState: who.storageStatePath } : {});
      const page = await ctx.newPage();
      await page.goto(route.replace('[slug]', who.orgSlug));
      for (const role of ['checkbox', 'radio'] as const) {
        await expect(page.getByRole(role, { name: /research/i })).toHaveCount(0);
      }
      await ctx.close();
    });
  }
}
