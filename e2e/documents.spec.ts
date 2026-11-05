import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, request as pwRequest, test, type Locator, type Page } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { testDb } from '../__tests__/helpers/db';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { expectNoHorizontalScroll } from './helpers/reflow';

/**
 * J-09 for the data card (FR-DOC-01, FR-DOC-04, FR-DOC-08; UX-20, UX-27, M-35; NFR-A11Y-02, NFR-A11Y-05, NFR-SEC-11). The
 * fixture organisation of e2e/fixtures/manifest.ts; the decisions, the review and the seal are made through the real routes with
 * each seat's own session, so the seal is REV-a's and the document DOC-a's.
 */
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
const org = manifest.orgs[0];
const HOSTILE = '<script>alert(1)</script>';

function seat(role: OrgRole) {
  const s = manifest.users.find((u) => u.orgSlug === org.slug && u.role === role && u.index === 0);
  if (!s) throw new Error(`the fixture manifest has no ${role} seat for ${org.slug}`);
  return s;
}

async function signIn(page: Page, role: OrgRole): Promise<void> {
  await page.context().clearCookies();
  const state = JSON.parse(readFileSync(seat(role).storageStatePath, 'utf8')) as { cookies: Array<{ name: string; value: string; domain: string; path: string }> };
  await page.context().addCookies(state.cookies);
}

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
  const p = await api<{ id: string }>(baseURL, 'owner', `/api/v1/orgs/${org.slug}/projects`, { name: `J-09 ${randomUUID().slice(0, 8)}`, aiSystemType: 'classification' });
  await api(baseURL, 'assessor', `/api/v1/orgs/${org.slug}/projects/${p.id}/decisions`, {
    requestId: randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-12', baseVersionNumber: null, status: 'done', scopeAnswer: null, optionsInPlace: [],
    reasonCode: null, reason: `End-to-end reason ${randomUUID()} for this decision.`, decidedBy: { kind: 'outside_role', role: 'principal_investigator' },
    declaredDate: '2026-10-30', evidenceIds: [],
  });
  const r = await api<{ id: string }>(baseURL, 'admin', `/api/v1/orgs/${org.slug}/projects/${p.id}/reviews`, { requestId: randomUUID(), stage: 'pre-processing', preparedFor: null });
  const s = await api<{ id: string }>(baseURL, 'reviewer', `/api/v1/orgs/${org.slug}/projects/${p.id}/reviews/${r.id}/seals`, { requestId: randomUUID() });
  return { projectId: p.id, reviewId: r.id, sealId: s.id };
}

/** Presses Tab until `target` has focus (keyboard only, NFR-A11Y-02), failing after 120 presses. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('tabTo: the target never took focus');
}

const issuedStatus = (page: Page) => page.getByRole('status').filter({ hasText: /^Issued\./ });

test('FR-DOC-08 FR-DOC-04 FR-DOC-01 NFR-A11Y-02 NFR-A11Y-05 NFR-SEC-11: generate, preview and issue a data card with the keyboard alone', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  failOnDialog(page);
  const { projectId, reviewId, sealId } = await sealedReview(baseURL!);
  await signIn(page, 'admin');
  const s18 = `/orgs/${org.slug}/projects/${projectId}/reviews/${reviewId}/documents`;
  await page.goto(s18);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Generate a document');
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
  await expectNoSeriousA11yViolations(page, 'S-18 preview');

  await tabTo(page, page.getByRole('button', { name: 'Back to edit' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Generate document' })).toBeFocused();
  expect(await testDb.issuedDocument.count({ where: { stageReviewId: reviewId } })).toBe(0);
  await page.keyboard.press('Enter');
  await expect(heading).toBeFocused();
  await tabTo(page, page.getByRole('button', { name: 'Issue this document' }));
  await page.keyboard.press('Enter');
  await expect(issuedStatus(page)).toHaveText(/^Issued\. SHA-256 [0-9a-f]{4} [0-9a-f]{4} \.\.\. [0-9a-f]{4}\.$/);
  await expect(issuedStatus(page)).toBeFocused();
  await expectFocusVisibleAndUncovered(page);
  await expect(page.getByRole('link', { name: /^Download PDF \(\d+ KB\)$/ })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'S-18 issued');

  // The list after a reload: the SHA-256 shown is the one of the downloaded file (12.2 step 6).
  await page.goto(s18);
  const row = await testDb.issuedDocument.findFirstOrThrow({ where: { stageReviewId: reviewId } });
  const short = `${row.sha256.slice(0, 4)} ${row.sha256.slice(4, 8)} ... ${row.sha256.slice(60)}`;
  await expect(page.getByText(`SHA-256 ${short}`)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /^Download PDF \(\d+ KB\)$/ }).click()]);
  const bytes = readFileSync((await download.path()) as string);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(row.sealId).toBe(sealId);

  // UX-32 and NFR-A11Y-05: the three states in light and dark at 1280 and 360 wide, and no sideways scroll at 320.
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(s18);
      await expectNoSeriousA11yViolations(page, `S-18 list, ${scheme}, ${width}`);
      await expect(page.locator('#typed-DC-25')).toHaveValue(`CC BY 4.0 ${HOSTILE}`);   // the draft kept for next time
    }
  }
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(s18);
  await expectNoHorizontalScroll(page);
  await page.locator('#typed-DC-25').fill('CC BY 4.0');
  await page.getByRole('button', { name: 'Generate document' }).click();
  await expect(page.getByRole('heading', { name: /^Preview: Data card/ })).toBeFocused();
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page, 'S-18 preview, 320');
});

test('UX-20 UX-27: a lost Issue shows the 7.4.2 line with [Retry], and Retry resends the same request id', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  failOnDialog(page);
  const { projectId, reviewId } = await sealedReview(baseURL!);
  await signIn(page, 'admin');
  await page.goto(`/orgs/${org.slug}/projects/${projectId}/reviews/${reviewId}/documents`);
  await page.getByRole('button', { name: 'Generate document' }).click();
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
  const alert = page.getByRole('alert').filter({ hasText: 'Not generated' });
  await expect(alert).toContainText('Not generated: connection lost. Nothing was issued.');
  await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(await testDb.issuedDocument.count({ where: { stageReviewId: reviewId } })).toBe(0);
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(issuedStatus(page)).toHaveText(/^Issued\./);
  expect(sent).toHaveLength(2);
  expect(sent[1].requestId).toBe(sent[0].requestId);
  expect(await testDb.issuedDocument.count({ where: { stageReviewId: reviewId } })).toBe(1);
});
