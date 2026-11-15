import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, request as pwRequest, test, type Page } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { testDb } from '../__tests__/helpers/db';
import { expectNoSeriousA11yViolations, settleHover } from './helpers/a11y';
import { expectMainDoesNotScroll, org, seat, signIn, tabTo } from './helpers/s18';
import { DOCUMENTS_COPY } from '../lib/documents/copy';
import { failOnDialog } from './helpers/dialogs';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { expectNoHorizontalScroll } from './helpers/reflow';

/**
 * J-09 for the data card (FR-DOC-01, FR-DOC-04, FR-DOC-08; UX-20, UX-27, M-35; NFR-A11Y-02, NFR-A11Y-05, NFR-SEC-11). The
 * fixture organisation of e2e/fixtures/manifest.ts; the decisions, the review and the seal are made through the real routes with
 * each seat's own session, so the seal is REV-a's and the document DOC-a's.
 */
const HOSTILE = '<script>alert(1)</script>';

async function api<T>(baseURL: string, role: OrgRole, path: string, data: Record<string, unknown>): Promise<T> {
  const ctx = await pwRequest.newContext({ baseURL, storageState: seat(role).storageStatePath });
  try {
    const res = await ctx.post(path, { data });
    if (!res.ok()) throw new Error(`${path} answered ${res.status()}: ${await res.text()}`);
    return (await res.json()) as T;
  } finally {
    await ctx.dispose();
  }
}

/** A project with one decision, one pre-processing review and its seal 1 (REV-a's route). */
async function sealedReview(baseURL: string): Promise<{ projectId: string; reviewId: string; sealId: string }> {
  const p = await api<{ id: string }>(baseURL, 'owner', `/api/v1/orgs/${org.slug}/projects`, { requestId: randomUUID(), name: `J-09 ${randomUUID().slice(0, 8)}`, aiSystemType: 'classification' });
  await api(baseURL, 'assessor', `/api/v1/orgs/${org.slug}/projects/${p.id}/decisions`, {
    requestId: randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-12', baseVersionNumber: null, status: 'done', scopeAnswer: null, optionsInPlace: [],
    reasonCode: null, reason: `End-to-end reason ${randomUUID()} for this decision.`, decidedBy: { kind: 'outside_role', role: 'principal_investigator' },
    declaredDate: '2026-10-30', evidenceIds: [],
  });
  const r = await api<{ id: string }>(baseURL, 'admin', `/api/v1/orgs/${org.slug}/projects/${p.id}/reviews`, { requestId: randomUUID(), stage: 'pre-processing', preparedFor: null });
  const s = await api<{ id: string }>(baseURL, 'reviewer', `/api/v1/orgs/${org.slug}/projects/${p.id}/reviews/${r.id}/seals`, { requestId: randomUUID() });
  return { projectId: p.id, reviewId: r.id, sealId: s.id };
}

const issuedStatus = (page: Page) => page.getByRole('status').filter({ hasText: /^Issued\./ });

test('FR-DOC-08 FR-DOC-04 FR-DOC-01 NFR-A11Y-02 NFR-A11Y-05 NFR-SEC-11: generate, preview and issue a data card with the keyboard alone', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  failOnDialog(page);
  const { projectId, reviewId, sealId } = await sealedReview(baseURL!);
  await signIn(page, 'admin');
  const s18 = `/orgs/${org.slug}/projects/${projectId}/reviews/${reviewId}/documents`;
  await page.goto(s18);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(DOCUMENTS_COPY.page.heading);
  await expect(page.getByText('No documents issued from this review yet.')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'S-18 form');

  await tabTo(page, page.getByRole('radio', { name: 'Data card' }));
  await expectFocusVisibleAndUncovered(page);
  await tabTo(page, page.locator('#typed-DC-25'));
  await page.keyboard.type(`CC BY 4.0 ${HOSTILE}`);
  await page.keyboard.press('Enter');
  const heading = page.getByRole('heading', { name: /^Preview: Data card/ });
  await expect(heading).toBeFocused();
  await expectFocusVisibleAndUncovered(page);
  const preview = page.locator('.document-preview');
  await expect(preview).toContainText('Not recorded');
  await expect(preview).toContainText(`CC BY 4.0 ${HOSTILE}`);
  expect(await page.locator('main script').count()).toBe(0);
  // R10-3: the AL-1 sentence is the only line of the preview inside a data-claims-allowed element.
  const allowed = page.locator('.document-preview [data-claims-allowed]');
  await expect(allowed).toHaveCount(1);
  expect(await allowed.getAttribute('data-claims-allowed')).toMatch(/^AL-1\b/);
  expect(await testDb.issuedDocument.count({ where: { stageReviewId: reviewId } })).toBe(0);   // FR-DOC-08: nothing stored yet
  await settleHover(page);
  await expectNoSeriousA11yViolations(page, 'S-18 preview');

  await tabTo(page, page.getByRole('button', { name: 'Back to edit' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: DOCUMENTS_COPY.form.previewButton })).toBeFocused();
  expect(await testDb.issuedDocument.count({ where: { stageReviewId: reviewId } })).toBe(0);
  await page.keyboard.press('Enter');
  await expect(heading).toBeFocused();
  await tabTo(page, page.getByRole('button', { name: 'Issue this document' }));
  await page.keyboard.press('Enter');
  await expect(issuedStatus(page)).toHaveText(/^Issued\. Fingerprint [0-9a-f]{4} [0-9a-f]{4} \.\.\. [0-9a-f]{4}\.$/);
  await expect(issuedStatus(page)).toBeFocused();
  // N3: router.refresh() after the Issue brings the new document into the list below with no reload.
  await expect(page.getByText('No documents issued from this review yet.')).toHaveCount(0);
  await expect(page.getByText(/^Data card[\u00a0 ]· seal 1[\u00a0 ]· /)).toBeVisible();
  await expectFocusVisibleAndUncovered(page);
  // The status line (M-35) and the refreshed list (W-9) each carry a link to the same file.
  const downloads = page.getByRole('link', { name: /^Download PDF \(\d+ KB\)$/ });
  await expect(downloads).toHaveCount(2);
  expect(await downloads.evaluateAll((els) => new Set(els.map((e) => e.getAttribute('href'))).size)).toBe(1);
  // CONSOLIDATED section 4: no country table below the documents (the UNCST table was removed).
  await expect(page.getByText(/UNCST|AI protocol issues/)).toHaveCount(0);
  await settleHover(page);
  await expectNoSeriousA11yViolations(page, 'S-18 issued');

  // The list after a reload: the SHA-256 shown is the one of the downloaded file (12.2 step 6).
  await page.goto(s18);
  const row = await testDb.issuedDocument.findFirstOrThrow({ where: { stageReviewId: reviewId } });
  const short = `${row.sha256.slice(0, 4)} ${row.sha256.slice(4, 8)} ... ${row.sha256.slice(60)}`;
  await expect(page.getByText(`Fingerprint ${short}`)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /^Download PDF \(\d+ KB\)$/ }).click()]);
  const bytes = readFileSync((await download.path()) as string);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(row.sealId).toBe(sealId);

  // UX-32 and NFR-A11Y-05: the three states in light and dark at 1280 and 360 wide, and no sideways scroll at 320.
  // The reviewer seat holds document:generate too; it carries this loop so the admin seat keeps most of its ten previews and issues an hour (C4 M3).
  await signIn(page, 'reviewer');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(s18);
      await expectNoSeriousA11yViolations(page, `S-18 form and issued list, ${scheme}, ${width}`);
      await expect(page.locator('#typed-DC-25')).toHaveValue(`CC BY 4.0 ${HOSTILE}`);   // the draft kept for next time
      // The form with the issued list is the page above; the preview is the state a Generate leaves. (C4 SC-1)
      await page.getByRole('button', { name: DOCUMENTS_COPY.form.previewButton }).click();
      await expect(page.getByRole('heading', { name: /^Preview: Data card/ })).toBeFocused();
      await settleHover(page);
      await expectNoSeriousA11yViolations(page, `S-18 preview, ${scheme}, ${width}`);
      if (width === 360) {
        // One Issue per scheme: the issued state with a second document in the list, checked in this scheme and at this width.
        await page.getByRole('button', { name: 'Issue this document' }).click();
        await expect(issuedStatus(page)).toHaveText(/^Issued\./);
        await settleHover(page);
        await expectNoSeriousA11yViolations(page, `S-18 issued, ${scheme}, ${width}`);
      }
    }
  }
  await signIn(page, 'admin');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(s18);
  await expectNoHorizontalScroll(page);
  await expectMainDoesNotScroll(page);
  await page.locator('#typed-DC-25').fill('CC BY 4.0');
  await page.getByRole('button', { name: DOCUMENTS_COPY.form.previewButton }).click();
  await expect(page.getByRole('heading', { name: /^Preview: Data card/ })).toBeFocused();
  await expectNoHorizontalScroll(page);
  await expectMainDoesNotScroll(page);
  await settleHover(page);
  await expectNoSeriousA11yViolations(page, 'S-18 preview, 320');
});

test('UX-20 UX-27: a lost Issue says it may have arrived, with [Retry], and Retry resends the same request id', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  failOnDialog(page);
  // The documents routes allow ten previews and issues an hour per user; the first test above, with the C4 SC-1 axe loop, uses nine for the admin seat, so these two sign in as the owner.
  const { projectId, reviewId } = await sealedReview(baseURL!);
  await signIn(page, 'owner');
  await page.goto(`/orgs/${org.slug}/projects/${projectId}/reviews/${reviewId}/documents`);
  await page.getByRole('button', { name: DOCUMENTS_COPY.form.previewButton }).click();
  await expect(page.getByRole('heading', { name: /^Preview: Data card/ })).toBeFocused();

  const sent: Array<{ requestId: string }> = [];
  let abortNext = true;
  await page.route(`**/api/v1/orgs/${org.slug}/projects/${projectId}/reviews/${reviewId}/documents`, async (route) => {
    sent.push(JSON.parse(route.request().postData() ?? '{}') as { requestId: string });
    if (abortNext) {
      abortNext = false;
      await route.abort('connectionfailed');
    } else {
      await route.continue();
    }
  });
  await page.getByRole('button', { name: 'Issue this document' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Not issued yet' });
  await expect(alert).toContainText('Not issued yet: no reply from the server. It may have arrived. Retry is safe: it will not issue twice.');
  await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(await testDb.issuedDocument.count({ where: { stageReviewId: reviewId } })).toBe(0);
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(issuedStatus(page)).toHaveText(/^Issued\./);
  expect(sent).toHaveLength(2);
  expect(sent[1].requestId).toBe(sent[0].requestId);
  expect(await testDb.issuedDocument.count({ where: { stageReviewId: reviewId } })).toBe(1);
});

test('UX-20 (accessibility audit): a refused typed value is marked aria-invalid, described by its message, and takes focus', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  failOnDialog(page);
  const { projectId, reviewId } = await sealedReview(baseURL!);
  await signIn(page, 'owner');
  await page.goto(`/orgs/${org.slug}/projects/${projectId}/reviews/${reviewId}/documents`);
  await page.locator('#typed-DC-25').fill('x'.repeat(2001));
  await page.getByRole('button', { name: DOCUMENTS_COPY.form.previewButton }).click();
  await expect(page.getByRole('alert').filter({ hasText: DOCUMENTS_COPY.refusal.field('generating', 'Use at most 2000 characters.') })).toBeVisible();
  const field = page.locator('#typed-DC-25');
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAttribute('aria-describedby', /typed-error-DC-25/);
  await settleHover(page);
  await expectNoSeriousA11yViolations(page, 'S-18 refused field');
  expect(await testDb.issuedDocument.count({ where: { stageReviewId: reviewId } })).toBe(0);
});

test('NFR-A11Y-05 (Task 10): at 769, 800, 820 and 1024 px wide the main landmark has no horizontal overflow on S-18', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  failOnDialog(page);
  const { projectId, reviewId } = await sealedReview(baseURL!);
  await signIn(page, 'reviewer');   // the generate form is on the page too; GETs do not spend the documents budget
  // 1024 px: the narrowest main beside the rail's column.
  for (const width of [769, 800, 820, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/orgs/${org.slug}/projects/${projectId}/reviews/${reviewId}/documents`);
    await expect(page.getByRole('heading', { name: 'Issued documents', level: 2 })).toBeVisible();
    const m = await page.evaluate(() => {
      const main = document.querySelector('.shell__main') as HTMLElement;
      return { mainScroll: main.scrollWidth, mainClient: main.clientWidth };
    });
    expect(m.mainScroll, `.shell__main at ${width}`).toBeLessThanOrEqual(m.mainClient);
    await expectNoHorizontalScroll(page);
  }
});
