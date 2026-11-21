import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';
import { closeOpenedContexts } from './helpers/contexts';

// Every context a test opened is closed after it (helpers/contexts.ts says why).
test.afterEach(closeOpenedContexts);

/**
 * The live drive of units/UI.md "Done": a viewer seat on organisation A, driven in a real browser, with screenshots and the values
 * seen written to LIVE_DRIVE_DIR. It records and asserts three things: the role "viewer" under the name, the dark theme's link
 * colour (D-3: the light orange --color-primary-light, rgb(232, 147, 90)), and M-40 when the browser goes offline. It runs only
 * when LIVE_DRIVE_DIR is set, so CI skips it.
 */
const DIR = process.env.LIVE_DRIVE_DIR;

test('live drive: viewer seat, role under the name, dark link colour, M-40 offline', async ({ browser }) => {
  test.skip(!DIR, 'set LIVE_DRIVE_DIR to run the live drive');
  fs.mkdirSync(DIR!, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as FixtureManifest;
  const slug = manifest.orgs[0].slug;
  const seat = manifest.users.find((u) => u.orgSlug === slug && u.role === 'viewer')!;
  const context = await browser.newContext({ storageState: seat.storageStatePath, colorScheme: 'dark', viewport: { width: 1280, height: 800 } });
  const seen: Record<string, string> = {};
  try {
    const page = await context.newPage();
    await page.goto(`/orgs/${slug}/dashboard`);
    seen.role = (await page.locator('.shell-rail__role').textContent()) ?? '';
    expect(seen.role).toBe('Viewer');
    await page.screenshot({ path: path.join(DIR!, '1-viewer-dark-dashboard.png') });

    await page.goto('/about');
    const link = page.locator('main a').first();
    seen.darkLinkColour = await link.evaluate((a) => getComputedStyle(a).color);
    expect(seen.darkLinkColour).toBe('rgb(232, 147, 90)');
    await page.screenshot({ path: path.join(DIR!, '2-dark-about-link.png') });

    await page.goto(`/orgs/${slug}/dashboard`);
    await context.setOffline(true);
    await expect(page.getByRole('status').filter({ hasText: 'You are offline.' })).toBeVisible();
    seen.offline = (await page.locator('.ui-banner__body').textContent()) ?? '';
    await page.screenshot({ path: path.join(DIR!, '3-offline-banner.png') });
    await context.setOffline(false);
  } finally {
    fs.writeFileSync(path.join(DIR!, 'seen.json'), JSON.stringify(seen, null, 2));
    await context.close();
  }
});
