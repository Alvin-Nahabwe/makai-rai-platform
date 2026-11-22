import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { GUIDANCE_COPY } from '../lib/guidance/copy';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { closeOpenedContexts } from './helpers/contexts';

// Every context a test opened is closed after it (helpers/contexts.ts says why).
test.afterEach(closeOpenedContexts);

/**
 * S-26, the framework reference page (FR-CNT-01, UX-32, UX-36, NFR-A11Y-02, NFR-A11Y-05), driven in the browser as a
 * fixture owner. The live server serves H0's fixture bundle (playwright.config.ts passes MAKRAI_TEST_SEAMS and the
 * fixture root), whose counts are the 4.0.0 backbone's.
 */

// owner storageState from e2e/fixtures/.auth/manifest.json, which the setup project writes before this project runs
const manifest: FixtureManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
const ownerSeat = manifest.users.find((u) => u.role === 'owner' && u.orgSlug === manifest.orgs[0].slug);
if (!ownerSeat) throw new Error('content-framework: the fixture manifest holds no owner of the first organisation');
const OWNER = ownerSeat.storageStatePath;

test.use({ storageState: OWNER });

for (const width of [1280, 360]) for (const colorScheme of ['light', 'dark'] as const)
  test(`UX-32 NFR-A11Y-05 FR-CNT-01: S-26 at ${width} ${colorScheme} has no serious axe violation and no horizontal scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme });
    await page.goto('/explore/framework');
    await expectNoSeriousA11yViolations(page, `S-26 ${width} ${colorScheme}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

test('UX-36 FR-CNT-01: S-26 content without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ storageState: OWNER, javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto('/explore/framework');
    await expect(page.getByRole('heading', { level: 1, name: GUIDANCE_COPY.framework.heading, exact: true })).toBeVisible();
    for (const name of ['Pre-processing', 'In-processing', 'Post-processing']) await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
    await expect(page.getByText(GUIDANCE_COPY.framework.counts(3, 6, 21, 28))).toBeVisible();
    await expect(page.locator('[id^="area-card-"]')).toHaveCount(21);
  } finally {
    await context.close();
  }
});

test('NFR-A11Y-02 NFR-A11Y-05: S-26 at 320 px reflows and every control link is reached by keyboard with visible focus', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 }); await page.goto('/explore/framework');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= 320)).toBe(true);
  const link = page.locator('a[href^="/explore/controls#"]').first();
  // The page scrolls smoothly (app/globals.css), so the browser brings the focused link into view over a few frames.
  await link.focus(); await expect(link).toBeInViewport({ ratio: 1 }); await expectFocusVisibleAndUncovered(page);
});

for (const colorScheme of ['light', 'dark'] as const)
  test(`UX-32 NFR-A11Y-05 FR-CNT-01: S-26 at 1280 ${colorScheme} with every research source list open has no serious axe violation`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 }); await page.emulateMedia({ colorScheme });
    await page.goto('/explore/framework');
    // Each area's sources are a native <details> (components/report/ReferencesList.tsx); open every one by its summary.
    const summaries = page.locator('details.references-list > summary');
    const n = await summaries.count();
    expect(n).toBeGreaterThan(0);
    // The drawn open/closed marker (review r1 M-5): a marker is there when closed, and it turns when the list opens.
    const marker = () => summaries.first().evaluate((el) => {
      const m = getComputedStyle(el, '::before');
      return { content: m.content, width: m.borderInlineStartWidth, transform: m.transform };
    });
    const closed = await marker();
    expect(closed.content).toBe('""');
    expect(closed.width).toBe('6px');
    for (let i = 0; i < n; i++) await summaries.nth(i).click();
    await expect(page.locator('details.references-list[open]')).toHaveCount(n);
    await expect.poll(async () => (await marker()).transform).not.toBe(closed.transform);
    await expectNoSeriousA11yViolations(page, `S-26 1280 ${colorScheme}, sources open`);
  });

test('UX-03 FR-PUB-02 FR-CNT-01: every principle link on S-26 lands on a section of /about', async ({ page }) => {
  await page.goto('/explore/framework');
  const hrefs = await page.locator('a[href^="/about#principle-"]').evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href') as string));
  expect(hrefs, 'one principle link per risk area').toHaveLength(21);
  const ids = [...new Set(hrefs.map((h) => h.slice('/about#'.length)))];
  await page.goto('/about');
  for (const id of ids) expect(await page.locator(`[id="${id}"]`).count(), `/about has #${id}`).toBe(1);
  await page.goto('/explore/framework');
  await page.locator('a[href^="/about#principle-"]').first().click();
  await page.waitForURL((url) => url.pathname === '/about' && url.hash.startsWith('#principle-'));
  await expect(page.locator(`[id="${new URL(page.url()).hash.slice(1)}"]`)).toBeInViewport();
});
