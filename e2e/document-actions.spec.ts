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
 * J-11 on S-18 (FR-DOC-06, FR-DOC-07; UX-29, M-36; NFR-A11Y-02, NFR-A11Y-05): copy a document's text and withdraw it with the keyboard
 * alone. The fixture organisation of e2e/fixtures/manifest.ts; the data card is issued through the real route as the admin seat
 * (DOC-a's flow is `documents.spec.ts`), and the owner seat withdraws it on the screen.
 */
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
const org = manifest.orgs[0];
const REASON = 'Sent to the wrong committee.';

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

/** A project with one decision, a sealed pre-processing review and one issued data card. */
async function issuedCard(baseURL: string): Promise<{ projectId: string; reviewId: string; documentId: string }> {
  const p = await api<{ id: string }>(baseURL, 'owner', `/api/v1/orgs/${org.slug}/projects`, { requestId: randomUUID(), name: `J-11 ${randomUUID().slice(0, 8)}`, aiSystemType: 'classification' });
  await api(baseURL, 'assessor', `/api/v1/orgs/${org.slug}/projects/${p.id}/decisions`, {
    requestId: randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-12', baseVersionNumber: null, status: 'done', scopeAnswer: null, optionsInPlace: [],
    reasonCode: null, reason: `End-to-end reason ${randomUUID()} for this decision.`, decidedBy: { kind: 'outside_role', role: 'principal_investigator' },
    declaredDate: '2026-10-30', evidenceIds: [],
  });
  const r = await api<{ id: string }>(baseURL, 'admin', `/api/v1/orgs/${org.slug}/projects/${p.id}/reviews`, { requestId: randomUUID(), stage: 'pre-processing', preparedFor: null });
  const s = await api<{ id: string }>(baseURL, 'reviewer', `/api/v1/orgs/${org.slug}/projects/${p.id}/reviews/${r.id}/seals`, { requestId: randomUUID() });
  const d = await api<{ id: string }>(baseURL, 'admin', `/api/v1/orgs/${org.slug}/projects/${p.id}/reviews/${r.id}/documents`, {
    requestId: randomUUID(), documentType: 'data_card', sealId: s.id, typedFields: {},
  });
  return { projectId: p.id, reviewId: r.id, documentId: d.id };
}

/** Presses Tab until `target` has focus (keyboard only, NFR-A11Y-02), failing after 120 presses. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('tabTo: the target never took focus');
}

async function expectMainDoesNotScroll(page: Page): Promise<void> {
  const m = await page.evaluate(() => { const el = document.querySelector('.app-main') as HTMLElement; return { scroll: el.scrollWidth, client: el.clientWidth }; });
  expect(m.scroll, '.app-main scrollWidth').toBeLessThanOrEqual(m.client);
}

const printed = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

test('FR-DOC-06 FR-DOC-07 UX-29 NFR-A11Y-02 NFR-A11Y-05: copy and withdraw a document with the keyboard alone', async ({ page, context, baseURL }) => {
  test.setTimeout(240_000);
  failOnDialog(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { projectId, reviewId, documentId } = await issuedCard(baseURL!);
  const row = await testDb.issuedDocument.findUniqueOrThrow({ where: { id: documentId } });
  const s18 = `/orgs/${org.slug}/projects/${projectId}/reviews/${reviewId}/documents`;
  await signIn(page, 'owner');
  await page.goto(s18);

  // Copy as text: the clipboard holds the FR-DOC-07 marking first, and the page says so.
  const copy = page.getByRole('button', { name: 'Copy as text' });
  await tabTo(page, copy);
  await expectFocusVisibleAndUncovered(page);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Copied.' })).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip.split('\n')[0]).toBe(`Copy of the data card issued on ${printed(row.issuedAt.toISOString())}; the PDF is the issued version`);
  expect(clip).toContain('Data card');

  // Withdraw: the confirmation opens in place, takes focus, and reads M-36 for this data card and today's UTC day.
  const withdraw = page.getByRole('button', { name: 'Withdraw document' });
  await tabTo(page, withdraw);
  await expectFocusVisibleAndUncovered(page);
  await page.keyboard.press('Enter');
  const confirm = page.locator('[data-inline-confirm]');
  await expect(confirm.getByLabel('Reason (required)')).toBeFocused();
  await expectFocusVisibleAndUncovered(page);
  const today = printed(new Date().toISOString());
  await expect(confirm).toContainText(`Withdraw data card? It will show 'Withdrawn by the team on ${today}'. The document stays stored.`);
  await expect(confirm).toContainText(`Data card issued ${printed(row.issuedAt.toISOString())}`);
  await expect(confirm.getByRole('button', { name: 'Withdraw document' })).toBeDisabled();
  expect(await testDb.documentEvent.count({ where: { documentId } })).toBe(0);

  // Cancel returns focus to the Withdraw button (UX-42); nothing was written.
  await tabTo(page, confirm.getByRole('button', { name: 'Cancel' }));
  await page.keyboard.press('Enter');
  await expect(withdraw).toBeFocused();
  expect(await testDb.documentEvent.count({ where: { documentId } })).toBe(0);

  // The confirmation and the withdrawn line in both themes at 1280 and 360 wide, and no sideways scroll at 320.
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(s18);
      await page.getByRole('button', { name: 'Withdraw document' }).click();
      await expectNoSeriousA11yViolations(page, `S-18 confirm, ${scheme}, ${width}`);
    }
  }
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(s18);
  await page.getByRole('button', { name: 'Withdraw document' }).click();
  await expectNoHorizontalScroll(page);
  await expectMainDoesNotScroll(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(s18);

  // Withdraw for real, with the keyboard.
  await tabTo(page, page.getByRole('button', { name: 'Withdraw document' }));
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-inline-confirm]').getByLabel('Reason (required)')).toBeFocused();
  await page.keyboard.type(REASON);
  await tabTo(page, page.locator('[data-inline-confirm]').getByRole('button', { name: 'Withdraw document' }));
  await page.keyboard.press('Enter');
  await expect(page.getByText(`Withdrawn on ${today}: ${REASON}`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw document' })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Withdrawn.' })).toBeVisible();
  await expectFocusVisibleAndUncovered(page);
  const event = await testDb.documentEvent.findFirstOrThrow({ where: { documentId } });
  expect(event.reason).toBe(REASON);

  // The document stays: the PDF still downloads and hashes to the SHA-256 S-18 shows.
  const short = `${row.sha256.slice(0, 4)} ${row.sha256.slice(4, 8)} ... ${row.sha256.slice(60)}`;
  await expect(page.getByText(`SHA-256 ${short}`)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /^Download PDF \(\d+ KB\)$/ }).click()]);
  expect(createHash('sha256').update(readFileSync((await download.path()) as string)).digest('hex')).toBe(row.sha256);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(s18);
      await expectNoSeriousA11yViolations(page, `S-18 withdrawn, ${scheme}, ${width}`);
    }
  }
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(s18);
  await expectNoHorizontalScroll(page);
  await expectMainDoesNotScroll(page);
});

test('UX-29 FR-AUTHZ-01: a reviewer sees Copy as text and no Withdraw control', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  failOnDialog(page);
  const { projectId, reviewId } = await issuedCard(baseURL!);
  await signIn(page, 'reviewer');
  await page.goto(`/orgs/${org.slug}/projects/${projectId}/reviews/${reviewId}/documents`);
  await expect(page.getByRole('button', { name: 'Copy as text' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw document' })).toHaveCount(0);
});
