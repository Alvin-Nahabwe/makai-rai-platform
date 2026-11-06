import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectFocusVisibleAndUncovered } from './helpers/focus';

/**
 * S-27, the controls page (FR-SUG-04, FR-SUG-06, UX-32, NFR-A11Y-02, NFR-A11Y-05), driven in the browser as a fixture
 * owner. It reads the real data/resources.json.
 */

// owner storageState from e2e/fixtures/.auth/manifest.json, which the setup project writes before this project runs
const manifest: FixtureManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
const ownerSeat = manifest.users.find((u) => u.role === 'owner' && u.orgSlug === manifest.orgs[0].slug);
if (!ownerSeat) throw new Error('controls-page: the fixture manifest holds no owner of the first organisation');

test.use({ storageState: ownerSeat.storageStatePath });

for (const width of [1280, 360]) for (const colorScheme of ['light', 'dark'] as const)
  test(`UX-32 NFR-A11Y-05 FR-SUG-04: S-27 at ${width} ${colorScheme} has no serious axe violation and no horizontal scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme });
    await page.goto('/explore/controls');
    await expectNoSeriousA11yViolations(page, `S-27 ${width} ${colorScheme}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

test('NFR-A11Y-02: an S-26 control link reaches its card on S-27 and focus is visible', async ({ page }) => {
  await page.goto('/explore/controls#C-01');
  await expect(page.locator('#C-01')).toBeInViewport();
  await page.locator('#C-01 a').first().focus();
  await expectFocusVisibleAndUncovered(page);
});

test('FR-SUG-06: every passed template link answers 200', async ({ page, request }) => {
  await page.goto('/explore/controls');
  const hrefs = await page.locator('a[href^="/templates/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) expect((await request.get(href)).status(), href).toBe(200);
});

/** The released notebooks of the release resources file (FR-SUG-05), read as JSON here, a second root beside the page's loader. */
const releasedNotebooks: Array<{ file: string; requirementsFile: string; sha256: string }> =
  JSON.parse(fs.readFileSync('data/resources.json', 'utf-8')).notebooks.filter((n: { released: boolean }) => n.released);

test('FR-SUG-05: every notebook link answers 200 with the reviewed bytes, and the requirements file answers 200 (skipped while no notebook is released)', async ({ page, request }) => {
  test.skip(releasedNotebooks.length === 0, 'no notebook is released in data/resources.json yet; unit/c-nb-2 releases the first');
  await page.goto('/explore/controls');
  const hrefs = await page.locator('a[href^="/notebooks/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
  for (const n of releasedNotebooks) {
    expect(hrefs, n.file).toContain(n.file);
    expect(hrefs, n.requirementsFile).toContain(n.requirementsFile);
  }
  for (const href of new Set(hrefs)) {
    const response = await request.get(href);
    expect(response.status(), href).toBe(200);
    const entry = releasedNotebooks.find((n) => n.file === href);
    if (entry) expect(createHash('sha256').update(await response.body()).digest('hex'), href).toBe(entry.sha256);
  }
});
