import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { expectFocusVisibleAndUncovered } from './helpers/focus';

/**
 * S-28, the public About page, in a real browser (UX-03, FR-PUB-02, NFR-A11Y-01, NFR-A11Y-02,
 * NFR-A11Y-04, NFR-A11Y-05). The text of the page is proved on the server render by
 * `__tests__/unit/about-page.test.tsx`; this file proves what only a browser shows: that the page is
 * served to someone who is signed out, that the old address leads to it, that no serious axe rule
 * fails in either theme at a wide and a narrow width, and that the keyboard reaches every link in
 * order with a focus ring that is visible and not covered.
 *
 * The signed-out cases take no storage state: the project sets none (playwright.config.ts), so a
 * context starts logged out. The signed-in case reads a seat of the fixture the `setup` project
 * writes, when the test runs and not when the file loads.
 */

/** Read when the test runs, because `setup` writes the manifest after Playwright has collected the specs. */
function ownerSeat(): { storageStatePath: string; orgSlug: string } {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as FixtureManifest;
  const slug = manifest.orgs[0].slug;
  const owner = manifest.users.find((u) => u.orgSlug === slug && u.role === 'owner' && u.index === 0);
  if (!owner) throw new Error(`about.spec: no owner seat for ${slug} in the fixture manifest`);
  return { storageStatePath: owner.storageStatePath, orgSlug: slug };
}

/**
 * Waits until the page has stopped scrolling: its scroll position unchanged for five animation frames.
 * `app/globals.css:204` sets `scroll-behavior: smooth`, so a Tab that scrolls a link into view, or a
 * link to `#help-and-contact`, animates the scroll, and a check made at once reads the page mid-way.
 * The page is tested with its own motion on; it is not switched to reduced motion to avoid the wait.
 */
async function scrollSettled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let last = window.scrollY;
        let still = 0;
        const tick = () => {
          if (window.scrollY === last) {
            still += 1;
            if (still >= 5) return resolve();
          } else {
            still = 0;
            last = window.scrollY;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/**
 * Numbers every link inside `#about-page` in document order (`data-tab-index`), then tabs through the page from
 * its top and runs the focus check on every stop, until focus leaves the document or the cap is reached.
 * Returns the index of each numbered link that took focus, in the order it took it, so a caller can say
 * which links the keyboard reached and whether it reached them in reading order. Two links with the same
 * address are told apart by their index.
 */
async function tabThroughLinks(page: Page, cap: number): Promise<{ total: number; reached: number[] }> {
  const total = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('#about-page a[href]'));
    links.forEach((el, i) => el.setAttribute('data-tab-index', String(i)));
    (document.activeElement as HTMLElement | null)?.blur();
    return links.length;
  });
  const reached: number[] = [];
  for (let i = 0; i < cap; i += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      return el && el !== document.body ? { index: el.getAttribute('data-tab-index') } : null;
    });
    if (!stop) break;                                        // focus left the document
    await scrollSettled(page);
    await expectFocusVisibleAndUncovered(page);
    if (stop.index !== null) reached.push(Number(stop.index));
  }
  return { total, reached };
}

test('UX-03 FR-PUB-02 NFR-A11Y-04: /about is public, and /explore/about redirects to it', async ({ page }) => {
  failOnDialog(page);
  const response = await page.goto('/about');
  expect(response, '/about answered').not.toBeNull();
  expect(response!.status()).toBe(200);
  await expect(page.locator('#help-and-contact')).toBeVisible();
  expect(new URL(page.url()).pathname, 'signed out: /about was not sent to /login').toBe('/about');

  // The old address, signed out: a permanent redirect to the new one (next.config.ts redirects()).
  const old = await page.goto('/explore/about');
  expect(old, '/explore/about answered').not.toBeNull();
  expect(new URL(page.url()).pathname, 'the old address ends on the new page').toBe('/about');
  const redirect = await old!.request().redirectedFrom()?.response();
  expect(redirect?.status(), 'the old address answered a permanent redirect').toBe(308);
  await expect(page.locator('#help-and-contact')).toBeVisible();
});

test('UX-03 FR-PUB-02 NFR-A11Y-04: signed in as a seat, the footer About link reaches /about', async ({ browser, baseURL }) => {
  const seat = ownerSeat();
  const context = await browser.newContext({ baseURL, storageState: seat.storageStatePath });
  const page = await context.newPage();
  failOnDialog(page);
  await page.goto(`/orgs/${seat.orgSlug}/dashboard`);
  // The shell's rail has no About item (plan 1A Task 11): a signed-in person reaches About by the footer, on every page.
  await page.getByRole('navigation', { name: 'Footer' }).getByRole('link', { name: 'About', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/about');
  await expect(page.locator('#help-and-contact')).toBeVisible();

  // A bookmarked old address, typed into the address bar as a seat.
  await page.goto('/explore/about');
  expect(new URL(page.url()).pathname, 'the old address ends on the new page').toBe('/about');
  await context.close();
});

test('UX-03 FR-PUB-02: every principle link on the framework page lands on a section of /about', async ({ browser, baseURL }) => {
  const seat = ownerSeat();
  const context = await browser.newContext({ baseURL, storageState: seat.storageStatePath });
  const page = await context.newPage();
  failOnDialog(page);
  // Every area card of every stage is in the page's HTML (S-26 has no stage buttons, UX-36), so the links are all there.
  await page.goto('/explore/framework');
  const hrefs = await page.locator('a[href^="/about#principle-"]').evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href') as string));
  expect(hrefs.length, 'the framework page links each risk area\'s principle').toBeGreaterThan(0);
  const ids = [...new Set(hrefs.map((h) => h.slice('/about#'.length)))];
  await page.goto('/about');
  for (const id of ids) expect(await page.locator(`[id="${id}"]`).count(), `/about has #${id}`).toBe(1);

  // And a click lands there: the link is followed, the address keeps its fragment, and the section is on screen.
  await page.goto('/explore/framework');
  await page.locator('a[href^="/about#principle-"]').first().click();
  await page.waitForURL((url) => url.pathname === '/about' && url.hash.startsWith('#principle-'));
  await scrollSettled(page);
  const top = await page.locator(`[id="${new URL(page.url()).hash.slice(1)}"]`).evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(top, 'the principle section is inside the viewport').toBeGreaterThanOrEqual(0);
  expect(top, 'the principle section is inside the viewport').toBeLessThan(await page.evaluate(() => window.innerHeight));
  await context.close();
});

test('UX-03: /about#help-and-contact lands on the Help and contact section', async ({ page }) => {
  failOnDialog(page);
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto('/about#help-and-contact');
  await scrollSettled(page);
  const top = await page.locator('#help-and-contact').evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled, 'the page scrolled to the section').toBeGreaterThan(0);
  expect(top, 'the section starts inside the viewport').toBeGreaterThanOrEqual(0);
  expect(top, 'the section starts in the first half of the viewport').toBeLessThan(350);
});

// CONSOLIDATED section 4 (owner ruling, country content): the UNCST table left Help and contact; the section stays.
test('UX-03 NFR-A11Y-05: Help and contact holds no country table, and 360 px does not scroll sideways', async ({ page }) => {
  failOnDialog(page);
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto('/about');
  // The id is on the heading, so the section is found by the heading it is labelled by.
  const help = page.locator('section[aria-labelledby="help-and-contact"]');
  await expect(help.getByRole('heading', { name: 'Help and contact', level: 2 })).toBeVisible();
  await expect(help.locator('table')).toHaveCount(0);
  await expect(page.getByText(/UNCST|AI protocol issues/)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= 360)).toBe(true);
  await expectNoSeriousA11yViolations(page, 'S-28 Help and contact');
});

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1280, 360]) {
    test(`NFR-A11Y-01 NFR-A11Y-02 NFR-A11Y-05: S-28 has no serious violation in ${scheme} at ${width} px, and the keyboard reaches its links`, async ({ page }) => {
      failOnDialog(page);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/about');
      // The scheme took effect: the page background is dark in the dark run and light in the light run.
      const luminance = await page.evaluate(() => {
        const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      });
      if (scheme === 'dark') expect(luminance, 'the dark theme applied').toBeLessThan(0.3);
      else expect(luminance, 'the light theme applied').toBeGreaterThan(0.7);
      await expectNoSeriousA11yViolations(page, `S-28 ${scheme} ${width}`);

      // NFR-A11Y-05: nothing is wider than the window, and nothing is hidden by clipping the page sideways.
      const sideways = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const wide = Array.from(document.querySelectorAll('#about-page *')).filter((el) => el.getBoundingClientRect().right > width + 1);
        return { scroll: document.documentElement.scrollWidth - window.innerWidth, wide: wide.slice(0, 5).map((el) => `${el.localName}${el.id ? `#${el.id}` : ''}`) };
      });
      expect(sideways.scroll, 'the page scrolls sideways').toBeLessThanOrEqual(0);
      expect(sideways.wide, 'elements that reach past the right edge').toEqual([]);

      const { total, reached } = await tabThroughLinks(page, 200);
      expect(total, 'the page has links to reach').toBeGreaterThan(0);
      expect(reached, 'Tab reaches every link of the page once, in reading order').toEqual(Array.from({ length: total }, (_, i) => i));
    });
  }
}
