import { test, expect, Page } from '@playwright/test';

/**
 * No shared `login()` helper or pre-seeded `owner-a@test.local` fixtures
 * exist in this codebase (verified: `grep -rn "owner-a@test.local\|function login" e2e`
 * returns nothing) — every existing e2e spec (project.spec.ts, auth.spec.ts)
 * self-registers a fresh user instead. Mirrored that pattern here rather than
 * the brief's literal snippet, which assumes fixtures this repo doesn't have.
 * Reported per AGENTS.md §2 ("an assumption in the brief turns out to be
 * false -> report it, do not silently correct and continue").
 */
async function registerAndLogin(page: Page, orgName: string) {
  const user = {
    name: 'Org Routing Test User',
    email: `org-routing-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`,
    password: 'SecurePass123!',
  };
  await page.goto('/register');
  await page.fill('#name', user.name);
  await page.fill('#email', user.email);
  await page.fill('#orgName', orgName);
  await page.fill('#password', user.password);
  await page.fill('#confirmPassword', user.password);
  await page.locator('input[type="checkbox"]').first().check();
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/login?registered=true');
  await page.fill('#email', user.email);
  await page.fill('#password', user.password);
  await page.locator('button[type="submit"]').click();
  return user;
}

test.describe('Org URL routing', () => {
  /**
   * The brief's literal snippet (`login(page, 'owner-a@test.local')` then
   * `expect(page).toHaveURL(/\/orgs\/.../dashboard$/)` straight off `/`)
   * assumes a RETURNING user with `lastActiveOrgId` already set from a
   * prior session. That never happens for the self-registration flow this
   * repo's e2e suite uses (no fixtures/seeded multi-org users exist — see
   * the note on `registerAndLogin`), and — found while getting this test to
   * RED/GREEN honestly, not assumed — a full-codebase grep shows NOTHING in
   * this plan ever writes `lastActiveOrgId` (recorded on D-069 in
   * docs/DEFERRED_REGISTER.md). So a freshly registered user correctly
   * lands on the org PICKER (no hint yet), not an automatic redirect. This
   * test exercises the actually-reachable path: land on `/`, see the
   * picker, click through to the dashboard. `lib/org-dispatch.ts`'s own
   * unit tests (__tests__/unit/org-dispatch.test.ts) already cover the
   * redirect-when-hinted branch directly, without needing a database write
   * path that doesn't exist yet.
   */
  test('/ shows the org picker for a first-time user, pointing at the right org dashboard', async ({ page }) => {
    const orgName = `Org Routing A ${Date.now()}`;
    await registerAndLogin(page, orgName);
    await expect(page).toHaveURL('http://localhost:3000/');
    await expect(page.locator('h1')).toHaveText('Choose an organization');

    // Read the computed href rather than clicking through it. Clicking would
    // navigate into `/orgs/[slug]/dashboard`, which sits under
    // `app/(authenticated)/layout.tsx` — one of the 8 files D-113 records as
    // deliberately broken (`@/lib/auth-guard` deleted, Task 7's job to
    // restore) and off-limits for Task 6 to fix (fixing it would drop
    // `npm run typecheck` below the required 13 errors). In Next.js dev mode
    // that module-not-found is a Turbopack BUILD error, not a per-page
    // runtime one, and it poisons the dev server's error overlay for every
    // subsequent request until the process restarts — reproduced live while
    // developing this test (see the Task 6 report for the exact symptom:
    // a later /register load rendered only the stale Build Error dialog).
    // Reading the href proves app/page.tsx's dispatch logic resolves the
    // right destination without depending on a route this task doesn't own.
    const href = await page.getByRole('link', { name: orgName }).getAttribute('href');
    expect(href).toMatch(/^\/orgs\/[a-z0-9-]+\/dashboard$/);
  });

  test('a member of org A gets 404 on org B by direct URL', async ({ page, browser }) => {
    // Task 7 restored app/(authenticated)/layout.tsx (no longer imports the
    // deleted lib/auth-guard, D-113 closed), so `/orgs/[slug]/dashboard` now
    // renders live. `requireOrgContextFor` throws the SAME `NotFoundError`
    // for "unknown slug" and "not a member" (proven at the unit level by
    // __tests__/integration/org-context.test.ts); the `/orgs/[slug]` layout
    // maps that to `notFound()`, which Next.js serves as a 404 — the
    // end-to-end proof that a member of org A cannot distinguish "org B does
    // not exist" from "you are not a member of org B".
    const orgNameA = `Org Routing B1 ${Date.now()}`;
    await registerAndLogin(page, orgNameA);
    await expect(page).toHaveURL('http://localhost:3000/');
    const slugA = (await page.getByRole('link', { name: orgNameA }).getAttribute('href'))
      ?.split('/')[2];
    expect(slugA).toBeTruthy();

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await registerAndLogin(page2, `Org Routing B2 ${Date.now()}`);
    await expect(page2).toHaveURL('http://localhost:3000/');

    const res = await page2.goto(`/orgs/${slugA}/dashboard`);
    expect(res?.status()).toBe(404);
    await context2.close();
  });
});
