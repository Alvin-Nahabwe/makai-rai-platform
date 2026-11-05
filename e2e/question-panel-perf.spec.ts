import { expect, test, type Page } from '@playwright/test';
import { applyNetworkProfile, type NetworkProfile } from './helpers/network';
import { failOnDialog } from './helpers/dialogs';
import { fillValid, newProject, openQuestion, questionPath, saveStatus, seatOf } from './helpers/session';

/**
 * S-12 on slow links (NFR-PERF-03) and the size of a decision save (NFR-PERF-05). NFR-PERF-03 is verified on the
 * production-like build: this spec runs with CI=1 after `npm run build`, so Playwright serves `next start`; under the
 * dev server it is skipped, because a cold `next dev` compile measures the compiler, not the page. Q is a fixture id.
 */
const Q = 'Q-PP-01';
const PRODUCTION = !!process.env.CI;

test.beforeEach(async ({ page }) => { failOnDialog(page); });

const p95 = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.ceil(0.95 * s.length) - 1]; };

/** Saves `n` versions in a row through the form, each with a new reason; returns each click-to-"Saved as version" time. */
async function timeSaves(page: Page, n: number): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    await fillValid(page, { reason: `Save number ${i + 1} under a slow link` });
    const t = Date.now();
    await page.getByRole('button', { name: 'Save decision' }).click();
    await expect(saveStatus(page)).toHaveText(new RegExp(`^Saved as version ${i + 1} at `), { timeout: 20_000 });
    times.push(Date.now() - t);
    // the page refreshes its data after a save; the next save starts from the new version
    await expect(page.getByText(`Starting from version ${i + 1}`)).toBeVisible({ timeout: 20_000 });
  }
  return times;
}

for (const [profile, readyMs, saveMs] of [['Constrained', 6_000, 2_000], ['Poor', 15_000, 4_000]] as Array<[NetworkProfile, number, number]>) {
  test(`NFR-PERF-03: ${profile}: Save enabled within ${readyMs / 1000} s from a cold cache; Saved within ${saveMs / 1000} s at p95 over 20 saves`, async ({ browser, baseURL }) => {
    test.skip(!PRODUCTION, 'NFR-PERF-03 is measured on the production build (CI=1 serves next start)');
    test.setTimeout(300_000);
    const projectId = await newProject(baseURL!);
    const page = await (await browser.newContext({ storageState: seatOf('assessor').storageStatePath })).newPage();
    await applyNetworkProfile(page, profile);
    const t0 = Date.now();
    await page.goto(questionPath(projectId, Q));
    await expect(page.locator('[data-region="answer-form"] form[data-ready="true"]')).toBeVisible({ timeout: readyMs });
    await expect(page.getByRole('button', { name: 'Save decision' })).toBeEnabled({ timeout: readyMs });
    const ready = Date.now() - t0;
    const saves = await timeSaves(page, 20);
    console.log(`[NFR-PERF-03] ${profile}: ready ${ready} ms; saves p95 ${p95(saves)} ms; all ${saves.join(', ')}`);
    expect(ready).toBeLessThanOrEqual(readyMs);
    expect(p95(saves)).toBeLessThanOrEqual(saveMs);
  });
}

test('NFR-PERF-05: a decision save body is at most 32 KB', async ({ page, baseURL }) => {
  const sizes: number[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/decisions')) sizes.push(r.postDataBuffer()!.length); });
  await openQuestion(page, 'assessor', Q, baseURL!);
  await fillValid(page, { reason: '\u{1F600}'.repeat(4000) });
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText(/^Saved/);
  expect(sizes).toHaveLength(1);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(32 * 1024);
});
