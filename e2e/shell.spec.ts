import { test, expect, type Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { expectDownloadLinksShowKindAndSize } from './helpers/downloads';
import { readCreditLine } from '../lib/credit';
import { abortPendingBackgroundRequests } from './helpers/pendingLinks';

/**
 * The shell every page sits in (units UI, SRS 7.1.1 and 7.6): S-31, the offline
 * banner and the two helper self-tests, then the skip link, the footer and the
 * landmarks on nine pages (Task U1).
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

const SIGNED_OUT_PAGES = ['/login', '/about', '/no-such-page'];

function signedInPages(slug: string): string[] {
  return ['/', `/orgs/${slug}/dashboard`, `/orgs/${slug}/projects`, '/explore/framework', '/explore/controls'];
}

test.describe('skip link, footer and landmarks (SRS 7.1.1)', () => {
  for (const url of SIGNED_OUT_PAGES) {
    test(`UX-04 UX-03: signed out, ${url} has the skip link first, one main and the footer`, async ({ page }) => {
      await checkShell(page, url);
    });
  }

  test('UX-04 UX-03: signed in, five pages have the skip link first, one main and the footer', async ({ browser }) => {
    const { slug, context, page } = await signedInPage(browser);
    try {
      for (const url of signedInPages(slug)) await checkShell(page, url);
    } finally {
      await context.close();
    }
  });

  test("UX-03: Help and contact resolves to S-28's Help and contact part", async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Help and contact' }).click();
    await expect(page).toHaveURL(/\/about#help-and-contact$/);
    await expect(page.locator('#help-and-contact')).toBeVisible();
  });

  test('UX-03: the signed-out pages have a header with the product name, About and Sign in', async ({ page }) => {
    await page.goto('/about');
    const header = page.locator('body > header.public-header');
    await expect(header.getByRole('link')).toHaveText(['MAK-AI RAI Platform', 'About', 'Sign in']);
  });

  test('UX-04: a refused organisation address shows one main landmark and one skip-link target', async ({ browser }) => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as FixtureManifest;
    const { context, page } = await signedInPage(browser);
    try {
      const response = await page.goto(`/orgs/${manifest.orgs[1].slug}/dashboard`);
      expect(response!.status()).toBe(404);
      await expect(page.locator('main')).toHaveCount(1);
      await expect(page.locator('[id="main-content"]')).toHaveCount(1);
      await expect(page.locator('main')).toContainText('We cannot find this page');
    } finally {
      await context.close();
    }
  });
});

/** The first Tab lands on the skip link, Enter moves focus into main, and the footer holds the credit and the four links. */
async function checkShell(page: import('@playwright/test').Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('main'), url).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus'), url).toHaveText('Skip to content');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => !!document.activeElement?.closest('main')), `${url}: focus moves into main`).toBe(true);

  const credit = readCreditLine();
  const footer = page.locator('body > footer');
  await expect(footer, url).toContainText(credit.text);
  await expect(footer.locator('a'), url).toHaveText([credit.licence, 'Legal texts', 'About', 'Help and contact']);
}

function seatWithRole(role: string): { slug: string; seat: FixtureManifestUser } {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as FixtureManifest;
  const slug = manifest.orgs[0].slug;
  const seat = manifest.users.find((u) => u.orgSlug === slug && u.role === role);
  if (!seat) throw new Error(`shell.spec: no ${role} seat for ${slug}`);
  return { slug, seat };
}

test.describe('role under the name, offline banner on phones, no emoji', () => {
  test("UX-02: a viewer seat sees 'viewer' under the name on its organisation's pages and nothing on another organisation's", async ({ browser }) => {
    const { slug, seat } = seatWithRole('viewer');
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as FixtureManifest;
    const context = await browser.newContext({ storageState: seat.storageStatePath });
    try {
      const page = await context.newPage();
      await page.goto(`/orgs/${slug}/dashboard`);
      await expect(page.locator('.sidebar-user-role')).toHaveText('viewer');
      const response = await page.goto(`/orgs/${manifest.orgs[1].slug}/dashboard`);
      expect(response!.status()).toBe(404);
      await expect(page.locator('.sidebar-user-role')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('M-40 UX-35: at 360 pixels the fixed menu button does not cover the first words of the offline banner', async ({ browser }) => {
    const { slug, seat } = seatWithRole('viewer');
    const context = await browser.newContext({ storageState: seat.storageStatePath, viewport: { width: 360, height: 740 } });
    try {
      const page = await context.newPage();
      await page.goto(`/orgs/${slug}/dashboard`);
      await context.setOffline(true);
      const text = page.locator('.offline-banner__text');
      await expect(text).toHaveText(M40);
      const covered = await text.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const first = range.getClientRects()[0];
        const hit = document.elementFromPoint(first.left + 4, first.top + first.height / 2);
        return hit === null || !el.contains(hit);
      });
      expect(covered, 'something sits over the start of the banner text').toBe(false);
    } finally {
      await context.close();
    }
  });

  test('UX-41: no emoji in the hydrated shell, signed out or signed in, in either theme', async ({ browser }) => {
    const { slug, seat } = seatWithRole('viewer');
    for (const [signedIn, url] of [[false, '/login'], [false, '/about'], [true, `/orgs/${slug}/dashboard`]] as const) {
      for (const colorScheme of ['light', 'dark'] as const) {
        const context = await browser.newContext({ colorScheme, ...(signedIn ? { storageState: seat.storageStatePath } : {}) });
        try {
          await abortPendingBackgroundRequests(context);   // a prefetch of a pending shell link never settles, and networkidle waits for it
          const page = await context.newPage();
          await page.goto(url);
          await page.waitForLoadState('networkidle');
          await expect(page.getByRole('button', { name: /Switch to (light|dark) theme/ }).first()).toBeVisible();
          const found = await page.evaluate(() => {
            const text = document.body.innerText + ' ' + Array.from(document.querySelectorAll('[aria-label],[title]')).map((e) => `${e.getAttribute('aria-label')} ${e.getAttribute('title')}`).join(' ');
            return text.match(/\p{Extended_Pictographic}/gu) ?? [];
          });
          expect(found, `${url} ${colorScheme}`).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  });
});
