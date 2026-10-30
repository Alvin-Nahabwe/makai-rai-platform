import { test, expect, type Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';

/**
 * The shell every page sits in (units UI, SRS 7.1.1 and 7.6): S-31, the offline
 * banner and the two helper self-tests. The skip link and footer cases join this
 * file with Task U1.
 *
 * Seats come from the fixture manifest `auth.setup.ts` writes. It is read
 * inside a test, never at module scope, so listing the tests does not need it.
 */

function ownerSeat(): { slug: string; seat: FixtureManifestUser } {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as FixtureManifest;
  const slug = manifest.orgs[0].slug;
  const seat = manifest.users.find((u) => u.orgSlug === slug && u.role === 'owner' && u.index === 0);
  if (!seat) throw new Error(`shell.spec: no owner seat for ${slug}`);
  return { slug, seat };
}

async function signedInPage(browser: Browser) {
  const { slug, seat } = ownerSeat();
  const context = await browser.newContext({ storageState: seat.storageStatePath });
  return { slug, context, page: await context.newPage() };
}

test.describe('S-31 not found or no access', () => {
  test('FR-RM-03 (S-31): an unknown address and a removed report address answer 404 with S-31', async ({ browser }) => {
    const { slug, context, page } = await signedInPage(browser);
    try {
      for (const url of ['/no-such-page', `/orgs/${slug}/assessment/${randomUUID()}/report`]) {
        const response = await page.goto(url);
        expect(response!.status(), url).toBe(404);
        await expect(page.locator('main'), url).toContainText('We cannot find this page');
        await expect(page.getByRole('link', { name: 'Go to your home page' }), url).toBeVisible();
      }
    } finally {
      await context.close();
    }
  });
});

const M40 =
  'You are offline. Pages already open stay readable. Answers you type are kept on this device until you are back online and press Save or Retry. Opening another question needs a connection. Your answer on this page is kept.';

test.describe('M-40 offline banner', () => {
  test('M-40: going offline shows the banner and coming back hides it', async ({ page, context }) => {
    await page.goto('/login');
    await expect(page.getByText('You are offline.')).toHaveCount(0);
    await context.setOffline(true);
    await expect(page.getByRole('status').filter({ hasText: 'You are offline.' })).toHaveText(M40);
    await context.setOffline(false);
    await expect(page.getByText('You are offline.')).toHaveCount(0);
  });
});
