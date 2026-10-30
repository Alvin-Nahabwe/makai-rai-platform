import { test, expect, type Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { expectDownloadLinksShowKindAndSize } from './helpers/downloads';

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

// The two helpers below are other screens' checks (UX-35, UX-39). These cases prove
// each one can fail, on a page built with setContent, so no server page is involved.

test.describe('cross-screen helpers', () => {
  test('UX-39 (helper): a download link without kind and size is reported', async ({ page }) => {
    await page.setContent('<main><a download href="x.pdf">Data card</a></main>');
    await expect(expectDownloadLinksShowKindAndSize(page)).rejects.toThrow(/Data card/);

    await page.setContent(
      '<main><a download href="x.pdf">Data card (PDF, 84 KB)</a>' +
        '<a href="/templates/t.docx">Template (Word document, 12 KB)</a>' +
        '<a href="/notebooks/n.ipynb" download>Download notebook (.ipynb, 48 KB)</a>' +
        '<a href="/notebooks/requirements.txt" download>Download requirements.txt (1 KB)</a>' +
        '<a href="/export/p">Export (ZIP, 2.4 MB)</a>' +
        '<a href="/about">About</a></main>',
    );
    await expectDownloadLinksShowKindAndSize(page);
  });

  test('UX-39 (helper): a size alone, or a kind alone, is not enough', async ({ page }) => {
    await page.setContent('<main><a download href="x.pdf">Data card (84 KB)</a></main>');
    await expect(expectDownloadLinksShowKindAndSize(page)).rejects.toThrow(/Data card/);
    await page.setContent('<main><a download href="x.pdf">Data card (PDF)</a></main>');
    await expect(expectDownloadLinksShowKindAndSize(page)).rejects.toThrow(/Data card/);
  });

  test('UX-35 (helper): a page wider than the viewport is reported', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.setContent('<body style="margin:0"><div id="wide" style="width:400px;height:20px">wide</div></body>');
    await expect(expectNoHorizontalScroll(page)).rejects.toThrow(/wider than clientWidth/);

    await page.setContent('<body style="margin:0"><div style="width:300px;height:20px">fits</div></body>');
    await expectNoHorizontalScroll(page);
  });
});
