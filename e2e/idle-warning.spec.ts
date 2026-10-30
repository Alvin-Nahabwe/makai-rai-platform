import { test, expect, type Browser } from '@playwright/test';
import fs from 'node:fs';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';

/**
 * UX-43 (SRS 7.6.1; WCAG 2.2.1): two minutes before the 12-hour idle sign-out the page
 * warns, "Stay signed in" extends the session, and ignoring the warning signs the person
 * out. Obligation U-S7 (the warning sends no request while waiting) is in
 * e2e/shell-checks.spec.ts with the harness helpers.
 *
 * The first two cases run on the normal 12-hour server: page.clock moves only the page's
 * own timers, so no cookie or server clock changes. The third runs only on a server started
 * with the seam, MAKRAI_TEST_SEAMS=1 MAKRAI_TEST_IDLE_SECONDS=180, because the cookie and the
 * server's check use real time.
 */

const WARNING = 'You will be signed out in 2 minutes because nothing has happened for a while.';

async function ownerPage(browser: Browser) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as FixtureManifest;
  const slug = manifest.orgs[0].slug;
  const seat = manifest.users.find((u) => u.orgSlug === slug && u.role === 'owner' && u.index === 0);
  if (!seat) throw new Error(`idle-warning.spec: no owner seat for ${slug}`);
  const context = await browser.newContext({ storageState: seat.storageStatePath });
  return { slug, context, page: await context.newPage() };
}

test.describe('idle-sign-out warning', () => {
  test('UX-43: the warning appears two minutes before the idle sign-out and takes focus on Stay signed in', async ({ browser }) => {
    const { slug, context, page } = await ownerPage(browser);
    try {
      await page.clock.install();
      await page.goto(`/orgs/${slug}/dashboard`);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.clock.fastForward('11:58:01');
      await expect(page.getByRole('dialog')).toContainText(WARNING);
      await expect(page.getByRole('button', { name: 'Stay signed in' })).toBeFocused();
    } finally {
      await context.close();
    }
  });

  test('UX-43: Stay signed in extends the session', async ({ browser }) => {
    const { slug, context, page } = await ownerPage(browser);
    try {
      await page.clock.install();
      await page.goto(`/orgs/${slug}/dashboard`);
      const cookieExpiry = async () =>
        (await context.cookies()).find((c) => /session-token/.test(c.name))?.expires ?? 0;
      const before = await cookieExpiry();
      expect(before).toBeGreaterThan(0);
      await page.clock.fastForward('11:58:01');
      await expect(page.getByRole('dialog')).toContainText(WARNING);

      // Real time still runs on the server, so wait a moment for the new expiry to differ.
      await page.clock.resume();
      await page.waitForTimeout(1500);
      const sessionReads: string[] = [];
      page.on('request', (r) => {
        if (new URL(r.url()).pathname === '/api/auth/session') sessionReads.push(r.method());
      });
      await page.getByRole('button', { name: 'Stay signed in' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      expect(sessionReads).toEqual(['GET']);
      expect(await cookieExpiry()).toBeGreaterThan(before);
    } finally {
      await context.close();
    }
  });

  test('UX-43: ignoring the warning signs the person out at the idle limit', async ({ browser }) => {
    test.skip(process.env.MAKRAI_TEST_IDLE_SECONDS !== '180', 'run with MAKRAI_TEST_IDLE_SECONDS=180 so the server uses the 3-minute limit');
    const { slug, context, page } = await ownerPage(browser);
    try {
      await page.goto(`/orgs/${slug}/dashboard`);
      await page.waitForTimeout(181_000); // the cookie and the server's check use real time
      await page.reload();
      await expect(page).toHaveURL(/\/login/);
    } finally {
      await context.close();
    }
  });
});
