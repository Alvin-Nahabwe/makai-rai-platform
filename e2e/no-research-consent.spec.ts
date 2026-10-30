import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { expect, test, type Browser } from '@playwright/test';
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

/**
 * Where the owner pass is expected to end up. A route not named here ends on itself. The home
 * route is the org dispatcher (app/page.tsx), which sends a signed-in user to an org dashboard.
 */
const OWNER_LANDING: Record<string, string> = { '/': '/orgs/[slug]/dashboard' };

/**
 * Routes an org owner cannot render: the server sends the owner to `/`. Their owner pass is
 * declared with test.fixme so the reporter lists it as not run, instead of passing on the page the
 * owner was sent to. Remove a route from this list when a platform-administrator seat exists.
 */
const NOT_RENDERED_FOR_OWNER = ['/admin/settings', '/admin/users'];
const NOT_RENDERED_REASON = 'needs the platform administrator seat (ORG adds adminSeat())';

for (const signedIn of [false, true]) {
  for (const route of routes) {
    const title = `FR-RES-01: no page offers a research-consent control: ${route} ${signedIn ? 'owner' : 'signed out'}`;
    const check = async ({ browser }: { browser: Browser }) => {
      const who = owner();
      const ctx = await browser.newContext(signedIn ? { storageState: who.storageStatePath } : {});
      const page = await ctx.newPage();
      await page.goto(route.replace('[slug]', who.orgSlug));
      if (signedIn) {
        // Without this an expired or empty session would be sent to /login, the control check
        // below would run on the login page, and the owner pass would pass for the wrong page.
        const expected = (OWNER_LANDING[route] ?? route).replace('[slug]', who.orgSlug);
        expect(new URL(page.url()).pathname, `the owner pass of ${route} must end on ${expected}`).toBe(expected);
      }
      for (const role of ['checkbox', 'radio'] as const) {
        await expect(page.getByRole(role, { name: /research/i })).toHaveCount(0);
      }
      await ctx.close();
    };
    if (signedIn && NOT_RENDERED_FOR_OWNER.includes(route)) {
      test.fixme(title, { annotation: { type: 'fixme', description: NOT_RENDERED_REASON } }, check);
    } else {
      test(title, check);
    }
  }
}
