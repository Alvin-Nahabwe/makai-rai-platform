import { expect, test, type Page, type Request } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { actAsSeat, expectMovedOn, fillValid, openQuestionIn, saveStatus } from './helpers/session';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { M11 } from '../lib/decision/copy';

/**
 * Review B I-r4-1: "Save without this file" while a file is uploading saves the decision without it and says "When the
 * upload has finished, save again to add it." That promise holds only if the upload keeps going after the save: the new
 * version the save makes must not replace the evidence block (whose unmount aborts its uploads and drops an aborted one from
 * the list without a word). These cases hold the upload with page.route across the save and the new version's arrival.
 * The admin 0 seat: two uploads (one reaching the server), well inside the evidence route's 10 a minute. Each case makes its
 * project as that seat (openQuestionIn), not as the owner, whose project creations the other decision specs already spend.
 */
const Q = 'Q-PP-01';
const F = DECISION_FORM_COPY;

test.beforeEach(async ({ page }) => { failOnDialog(page); });

const isEvidencePost = (r: Request) => r.method() === 'POST' && /\/evidence$/.test(new URL(r.url()).pathname);
const isDecisionPost = (r: Request) => r.method() === 'POST' && /\/decisions$/.test(new URL(r.url()).pathname);
const pdf = (name: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n${name}\n`) });

/** Holds every evidence POST until `release(outcome)`; records any the page itself aborted. */
async function holdUploads(page: Page): Promise<{ release: (how: 'continue' | 'fail') => void; aborted: string[] }> {
  let release: (how: 'continue' | 'fail') => void = () => {};
  const held = new Promise<'continue' | 'fail'>((r) => { release = r; });
  const aborted: string[] = [];
  page.on('requestfailed', (r) => { if (isEvidencePost(r)) aborted.push(r.failure()?.errorText ?? 'failed'); });
  await page.route('**/evidence', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const how = await held;
    // The page may have cancelled the request while it was held: then there is nothing left to answer.
    try { if (how === 'fail') await route.abort('failed'); else await route.continue(); } catch { /* cancelled by the page */ }
  });
  return { release: (how) => release(how), aborted };
}

/** Starts an upload, presses the block's "Save without this file", and waits for the new version to arrive on the page. */
async function saveWithoutWhileUploading(page: Page, name: string): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(pdf(name));
  await expect(page.locator('[data-upload-progress] > progress')).toHaveAttribute('aria-label', `Uploading ${name}`);
  const sent = page.waitForRequest(isDecisionPost);
  await page.getByRole('button', { name: F.saveWithout(1) }).click();
  expect(((await sent).postDataJSON() as { evidenceIds: string[] }).evidenceIds).toEqual([]);
  await expect(saveStatus(page)).toHaveText(/^Saved at .+ as version 1\./, { timeout: 20_000 });
  await expect(page.getByText(`${F.savedWithout.before}${name}${F.savedWithout.after}`)).toBeVisible();
  // router.refresh() has brought version 1: the corner names it.
  await expect(page.locator('.decision-card__saved')).toContainText(F.card.savedAs(1).trim());
}

test('I-r4-1: after "Save without this file" the upload left out keeps going when the new version arrives; once it finishes, the next Save adds it', async ({ page }) => {
  await actAsSeat(page, 'admin'); await openQuestionIn(page, Q); await fillValid(page);
  const uploads = await holdUploads(page);
  await saveWithoutWhileUploading(page, 'left-out.pdf');
  // The defect: the new version remounted the evidence block, which aborted the upload and dropped it without a word.
  await expect(page.locator('[data-upload-progress] > progress')).toHaveAttribute('aria-label', 'Uploading left-out.pdf');
  expect(uploads.aborted).toEqual([]);
  const reply = page.waitForResponse((r) => isEvidencePost(r.request()));
  uploads.release('continue');
  const res = await reply;
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  await expect(page.getByText(/^Uploaded left-out\.pdf /)).toBeVisible();
  // The promise of the "Saved without" line: the next Save adds it, as version 2, on the version just saved (no conflict).
  const sent = page.waitForRequest(isDecisionPost);
  await page.locator('.decision-save-bar').getByRole('button', { name: F.save, exact: true }).click();
  expect(((await sent).postDataJSON() as { evidenceIds: string[] }).evidenceIds).toEqual([id]);
  await expectMovedOn(page, Q);   // the file went with the answer, so nothing was left out: this Save moves on
  expect(uploads.aborted).toEqual([]);
});

test('I-r4-1: when the upload left out then fails, nothing waits forever: Save waits with the file named as not uploaded and "Save without" offered, and saving without it is answered', async ({ page }) => {
  await actAsSeat(page, 'admin'); await openQuestionIn(page, Q); await fillValid(page);
  const uploads = await holdUploads(page);
  await saveWithoutWhileUploading(page, 'left-out-fails.pdf');
  await expect(page.locator('[data-upload-progress] > progress')).toHaveAttribute('aria-label', 'Uploading left-out-fails.pdf');
  uploads.release('fail');
  await expect(page.locator('[data-upload-progress]')).toHaveCount(0);
  await page.locator('.decision-save-bar').getByRole('button', { name: F.save, exact: true }).click();
  const wait = page.locator('[data-upload-wait]');
  // The owner's words of 14:30 for a failed file: it will not finish by itself.
  await expect(wait).toContainText(`left-out-fails.pdf${F.waiting.failed}`);
  const sent = page.waitForRequest(isDecisionPost);
  await wait.getByRole('button', { name: F.saveWithout(1) }).click();
  expect(((await sent).postDataJSON() as { evidenceIds: string[] }).evidenceIds).toEqual([]);
  // Without the file the answer is version 1's, so the server's own refusal answers the press: nothing waits.
  await expect(page.locator('[data-error-summary]')).toContainText(M11.unchanged(1));
  await expect(wait).toHaveCount(0);
});
