import 'dotenv/config';
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';
import { testDb } from '../__tests__/helpers/db';
import { buildOrg } from '../__tests__/helpers/recordFixture';
import { ORG_COPY, roleWithArticle } from '../lib/org/copy';
import { closeOpenedContexts } from './helpers/contexts';

// Every context a test opened is closed after it (helpers/contexts.ts says why).
test.afterEach(closeOpenedContexts);

/**
 * The members are fixture seats (e2e/fixtures/auth.setup.ts, K0a's buildTwoOrgFixture) with their
 * saved sessions: accounts come only from invitations (FR-ACC-01), so no spec registers its own.
 */
const manifest: FixtureManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
const [orgA, orgB] = manifest.orgs;
const ownerOf = (slug: string) => {
  const seat = manifest.users.find((u) => u.orgSlug === slug && u.role === 'owner' && u.index === 0);
  if (!seat) throw new Error(`org-routing: no owner seat for ${slug}`);
  return seat;
};

test.describe('Org URL routing', () => {
  /**
   * A member with no `lastActiveOrgId` lands on the org PICKER at `/`, not an automatic redirect;
   * `lib/org-dispatch.ts`'s unit tests cover the redirect-when-hinted branch. The fixture seats may
   * carry the hint from earlier runs, so this signs in a fresh account (K0a's buildOrg, with the
   * three acceptances) from its own client address.
   */
  test('/ shows the org picker for a first-time user, pointing at the right org dashboard', async ({ browser }) => {
    const fx = await buildOrg({ label: 'picker' });
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '10.49.0.1' } });
    const page = await context.newPage();
    await page.goto('/login');
    await page.fill('#email', fx.members.viewer.email);
    await page.fill('#password', fx.members.viewer.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname !== '/login');
    await page.goto('/');
    await expect(page).toHaveURL('/');
    await expect(page.locator('h1')).toHaveText(ORG_COPY.chooser.heading);
    await expect(page.locator(`a[href="/orgs/${fx.org.slug}/dashboard"]`)).toHaveCount(1);
    // Plan 1B Task 8: the plate names the organisation and says the person's role there, in the labelled list.
    const list = page.getByRole('list', { name: ORG_COPY.chooser.listLabel });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText(fx.org.name);
    await expect(list).toContainText(ORG_COPY.chooser.youAre(roleWithArticle('viewer')));
    await context.close();
    await testDb.$disconnect();
  });

  test('plan 1B Task 8: an account in no organisation sees the empty state, with no organisation link and no way to make one', async ({ browser }) => {
    const fx = await buildOrg({ label: 'noorg' });
    await testDb.membership.deleteMany({ where: { userId: fx.members.viewer.userId } });
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '10.49.0.2' } });
    const page = await context.newPage();
    await page.goto('/login');
    await page.fill('#email', fx.members.viewer.email);
    await page.fill('#password', fx.members.viewer.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname !== '/login');
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText(ORG_COPY.chooser.emptyHeading);
    await expect(page.getByRole('main')).toContainText(ORG_COPY.chooser.emptyTitle);
    await expect(page.getByRole('main')).toContainText(ORG_COPY.chooser.emptyBody);
    await expect(page.locator('a[href^="/orgs/"]')).toHaveCount(0);
    await context.close();
    await testDb.$disconnect();
  });

  test('a member of org A gets 404 on org B by direct URL', async ({ browser }) => {
    // `requireOrgContextFor` throws the SAME `NotFoundError` for "unknown slug" and "not a member"
    // (__tests__/integration/org-context.test.ts); the `/orgs/[slug]` layout maps it to `notFound()`.
    const context2 = await browser.newContext({ storageState: ownerOf(orgB.slug).storageStatePath });
    const page2 = await context2.newPage();
    const slugA = orgA.slug;

    const res = await page2.goto(`/orgs/${slugA}/dashboard`);
    expect(res?.status()).toBe(404);
    await context2.close();
  });
});
