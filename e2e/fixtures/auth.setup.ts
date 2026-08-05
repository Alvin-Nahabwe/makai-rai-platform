import 'dotenv/config';
import fs from 'node:fs';
import { test as setup } from '@playwright/test';
import { buildTwoOrgFixture } from '../../__tests__/helpers/fixture';
import { AUTH_DIR, MANIFEST_PATH, storageStatePathFor, type FixtureManifest, type FixtureManifestUser } from './manifest';

/**
 * Task 10: builds the shared 2-org x 5-role x 2-member fixture ONCE and logs
 * every one of the 20 users in for real, saving each session as a Playwright
 * `storageState` file. Runs as its own Playwright project ("setup" in
 * playwright.config.ts), a dependency of the main "chromium" project — so
 * it executes exactly once per `npm run test:e2e` run, before any spec.
 *
 * WHY THIS SHAPE (brief constraint 2): the next task's exhaustive live
 * matrix needs to act as each of 20 users. Doing that by logging in fresh
 * inside every spec — 20 logins x N specs — would make that matrix
 * unusably slow. Playwright's documented pattern for this is a "setup"
 * project that authenticates once and hands every other test a
 * `storageState` to reuse (https://playwright.dev/docs/auth) — that is
 * what this file is.
 *
 * SAME DATABASE AS THE APP, DELIBERATELY: this file runs in the Playwright
 * test runner's own Node process, separate from the `next dev` process
 * `playwright.config.ts`'s `webServer` spawns — but both processes load the
 * SAME `.env` (`dotenv/config` here; Next.js loads it natively for the dev
 * server), so `buildTwoOrgFixture()` writes to the identical Postgres
 * database `next dev` reads from. `resetDb()` (__tests__/helpers/db.ts) is
 * NOT used here — it refuses to run against anything but `makrai_test`, and
 * this is the real dev database, which may carry rows from manual testing
 * that must not be wiped. `buildTwoOrgFixture()`'s own run-id suffix on
 * every email/org name (see fixture.ts) is what makes repeated e2e runs
 * against this un-truncated database collision-free.
 *
 * NO DIRECT SESSION/COOKIE MINTING: every one of the 20 logins below goes
 * through the real `/login` form and NextAuth's credentials provider
 * (lib/auth.ts) — the identical path `e2e/auth.spec.ts` already exercises —
 * so the saved `storageState` is a session the application actually issues,
 * not a hand-crafted cookie.
 *
 * PER-USER SYNTHETIC IP (root-caused, not guessed — see the Task 10 report's
 * systematic-debugging section): `proxy.ts` rate-limits
 * `POST /api/auth/callback/credentials` to 15 attempts per 15 minutes,
 * keyed by `x-forwarded-for` (falling back to `x-real-ip`, then
 * `127.0.0.1`) — confirmed live with 8 successive logins from one IP
 * returning 302, the 9th onward 429. Every Playwright context here
 * otherwise shares one loopback connection to `next dev`, so login #16 of
 * 20 would 429 and `signIn()` would throw client-side (reproduced: the
 * 16th login — org b's assessor seat 1 — hung on "Signing in..." until the
 * 30s test timeout, browser console: `TypeError: Failed to construct
 * 'URL': Invalid URL`). A REAL deployment of 20 users does not collapse
 * onto one address the way one Playwright process does, so each context
 * below is given its own `x-forwarded-for` — the exact header `proxy.ts`
 * already trusts for this purpose (its own doc calls the limiter
 * "NAT-aware: designed for shared-IP classroom deployments"). This does not
 * defeat the control against its actual target (many rapid attempts from
 * ONE real client); it corrects an artifact of the local test topology.
 * `docs/DEFERRED_REGISTER.md` D-124 records the separate, real finding this
 * surfaced: 16+ genuine users behind one *actual* shared IP (a classroom
 * NAT with no per-client forwarding) would hit this same 429 today.
 *
 * MANIFEST/PATH HELPERS LIVE IN `./manifest.ts`, NOT HERE (`simplify`
 * altitude finding): this file calls Playwright's `test`/`setup` at module
 * scope, so a future spec importing `storageStatePathFor` or
 * `FixtureManifest` FROM HERE would also execute that top-level `setup(...)`
 * registration as an import side effect. `./manifest.ts` has no such call,
 * so it is safe for any spec to import.
 */

setup('build the 20-user fixture and authenticate every seat', async ({ browser }) => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const buildStarted = Date.now();
  const fixture = await buildTwoOrgFixture();
  const buildMs = Date.now() - buildStarted;
  // Measured, not estimated (brief constraint 3) — printed so `npm run
  // test:e2e`'s own output carries the number without a second script.
  console.log(`[fixture] buildTwoOrgFixture() took ${buildMs}ms for ${fixture.users.length} users`);

  const manifestUsers: FixtureManifestUser[] = [];

  for (const [i, user] of fixture.users.entries()) {
    // Distinct per seat — see the module doc above for why this is needed
    // and why it is not a security-control bypass.
    const syntheticIp = `10.42.0.${i + 1}`;
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': syntheticIp } });
    const page = await context.newPage();
    await page.goto('/login');
    await page.fill('#email', user.email);
    await page.fill('#password', user.password);
    await page.locator('button[type="submit"]').click();
    // Every fixture user is a brand-new login with no `lastActiveOrgId` set
    // yet (lib/org-dispatch.ts), so a successful sign-in always lands on
    // `/` — the same wait `e2e/auth.spec.ts` uses for the identical reason.
    await page.waitForURL('**/');

    const storageStatePath = storageStatePathFor(user);
    await context.storageState({ path: storageStatePath });
    await context.close();

    manifestUsers.push({ ...user, storageStatePath });
  }

  const manifest: FixtureManifest = { orgs: fixture.orgs, users: manifestUsers };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
});
