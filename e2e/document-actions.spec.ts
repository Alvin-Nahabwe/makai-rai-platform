import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, request as pwRequest, test } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { testDb } from '../__tests__/helpers/db';
import { expectNoSeriousA11yViolations, settleHover } from './helpers/a11y';
import { expectMainDoesNotScroll, org, seat, signIn, tabTo } from './helpers/s18';
import { DOCUMENTS_COPY, formatUtcDay } from '../lib/documents/copy';
import { failOnDialog } from './helpers/dialogs';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { expectNoHorizontalScroll } from './helpers/reflow';

/**
 * J-11 on S-18 (FR-DOC-06, FR-DOC-07; UX-29, M-36; NFR-A11Y-02, NFR-A11Y-05): copy a document's text and withdraw it with the keyboard
 * alone. The fixture organisation of e2e/fixtures/manifest.ts; the data card is issued through the real route as the admin seat
 * (DOC-a's flow is `documents.spec.ts`), and the owner seat withdraws it on the screen.
 */
const REASON = 'Sent to the wrong committee.';

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

/**
 * One issued card for the cases that leave the document alone (they fulfil the replies themselves), so the whole file spends three document
 * issues of the ten an hour per user: this one, the keyboard journey's, and the Retry case's.
 */
let shared: Promise<{ projectId: string; reviewId: string; documentId: string }> | undefined;
const sharedCard = (baseURL: string) => (shared ??= issuedCard(baseURL));
const s18Of = (c: { projectId: string; reviewId: string }) => `/orgs/${org.slug}/projects/${c.projectId}/reviews/${c.reviewId}/documents`;
const LOST = DOCUMENTS_COPY.actions.withdrawLost;
const withdrawRoute = (documentId: string) => `**/api/v1/orgs/${org.slug}/documents/${documentId}/withdrawal`;
const textRoute = (documentId: string) => `**/api/v1/orgs/${org.slug}/documents/${documentId}/text`;
const body409 = { error: 'already_withdrawn', code: 'already_withdrawn' };

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
  expect(clip.split('\n')[0]).toBe(`Copy of the data card issued on ${formatUtcDay(row.issuedAt.toISOString())}; the PDF is the issued version`);
  expect(clip).toContain('Data card');

  // Withdraw: the confirmation opens in place, takes focus, and reads M-36 for this data card and today's UTC day.
  const withdraw = page.getByRole('button', { name: 'Withdraw document' });
  await tabTo(page, withdraw);
  await expectFocusVisibleAndUncovered(page);
  await page.keyboard.press('Enter');
  const confirm = page.locator('[data-inline-confirm]');
  await expect(confirm.getByLabel('Reason (required)')).toBeFocused();
  await expectFocusVisibleAndUncovered(page);
  // SC 2.4.11: the confirmation opens wholly in view, so both of its buttons are on screen without a scroll (measured once, not retried).
  const view = page.viewportSize()!;
  for (const name of ['Withdraw document', 'Cancel']) {
    const b = (await confirm.getByRole('button', { name, exact: true }).boundingBox())!;
    const box = `${Math.round(b.x)},${Math.round(b.y)} to ${Math.round(b.x + b.width)},${Math.round(b.y + b.height)} in ${view.width}x${view.height}`;
    expect(b.x >= 0 && b.y >= 0 && b.x + b.width <= view.width && b.y + b.height <= view.height, `the confirmation's ${name} button is inside the viewport (box ${box})`).toBe(true);
  }
  const today = formatUtcDay(new Date().toISOString());
  await expect(confirm).toContainText(DOCUMENTS_COPY.actions.withdrawConsequence('data card'));
  await expect(confirm).toContainText(`Data card issued ${formatUtcDay(row.issuedAt.toISOString())}`);
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
      await settleHover(page);
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
  // The list states each fact as a term and its value (lane 6 row S9): the fingerprint is the value after "Fingerprint".
  await expect(page.getByRole('definition').filter({ hasText: short })).toBeVisible();
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
  const { projectId, reviewId } = await sharedCard(baseURL!);
  await signIn(page, 'reviewer');
  await page.goto(`/orgs/${org.slug}/projects/${projectId}/reviews/${reviewId}/documents`);
  await expect(page.getByRole('button', { name: 'Copy as text' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw document' })).toHaveCount(0);
});

test('UX-27 M-06 FR-DOC-06: a withdrawal whose reply is lost says it may have arrived, and Retry resends the same request id and withdraws once', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  failOnDialog(page);
  const card = await issuedCard(baseURL!);
  await signIn(page, 'owner');
  await page.goto(s18Of(card));
  const sent: Array<{ requestId: string; reason: string }> = [];
  let abortNext = true;
  await page.route(withdrawRoute(card.documentId), async (route) => {
    sent.push(JSON.parse(route.request().postData() ?? '{}') as { requestId: string; reason: string });
    if (abortNext) {
      abortNext = false;
      await route.abort('connectionfailed');
    } else {
      await new Promise((r) => setTimeout(r, 1_500));   // held, so the Retry is pressed while its send is out
      await route.continue();
    }
  });
  await page.getByRole('button', { name: 'Withdraw document' }).click();
  await page.getByLabel('Reason (required)').fill('Sent to the wrong committee.');
  await page.getByRole('button', { name: 'Withdraw document' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Not withdrawn yet' });
  await expect(alert).toContainText(LOST);
  expect(await testDb.documentEvent.count({ where: { documentId: card.documentId } })).toBe(0);
  const retryButton = page.getByRole('button', { name: 'Retry' });
  await retryButton.click();
  // D-398 item 4: the pressed Retry stays, busy and focused, while its send is out; focus never falls to the page body.
  await expect(retryButton).toBeFocused();
  await expect(retryButton).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'Withdrawn.' })).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.body || document.activeElement === null)).toBe(false);
  expect(sent).toHaveLength(2);
  expect(sent[1].requestId).toBe(sent[0].requestId);
  expect(await testDb.documentEvent.count({ where: { documentId: card.documentId } })).toBe(1);
  await expect(page.getByText(/^Withdrawn on .*: Sent to the wrong committee\.$/)).toBeVisible();
});

test('FR-DOC-06: a 409 already_withdrawn says someone else withdrew it first, and after a lost reply says the earlier request may have done it', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  failOnDialog(page);
  const card = await sharedCard(baseURL!);
  await signIn(page, 'owner');
  await page.goto(s18Of(card));
  await page.route(withdrawRoute(card.documentId), (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify(body409) }));
  await page.getByRole('button', { name: 'Withdraw document' }).click();
  await page.getByLabel('Reason (required)').fill('First try.');
  await page.getByRole('button', { name: 'Withdraw document' }).click();
  await expect(page.getByRole('status').filter({ hasText: DOCUMENTS_COPY.actions.withdrawTaken })).toBeVisible();
  expect(await testDb.documentEvent.count({ where: { documentId: card.documentId } })).toBe(0);

  // The same box after a send with no reply: the 409 may be this person's own request.
  await page.unroute(withdrawRoute(card.documentId));
  let aborted = false;
  await page.route(withdrawRoute(card.documentId), async (route) => {
    if (!aborted) { aborted = true; await route.abort('connectionfailed'); } else await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify(body409) });
  });
  await page.getByRole('button', { name: 'Withdraw document' }).click();
  await page.getByLabel('Reason (required)').fill('Second try.');
  await page.getByRole('button', { name: 'Withdraw document' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Not withdrawn yet' });
  await expect(alert).toContainText(LOST);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('status').filter({ hasText: DOCUMENTS_COPY.actions.withdrawEarlier })).toBeVisible();
});

test('FR-DOC-07 NFR-SEC-11: when the clipboard refuses, Copy as text shows the text in a read-only box to copy by hand', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  failOnDialog(page);
  const card = await sharedCard(baseURL!);
  await signIn(page, 'reviewer');
  // A browser that refuses the write (a denied permission): headless Chromium lets a click write to the clipboard, so the refusal is stood in for.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });
  });
  await page.goto(s18Of(card));
  await page.getByRole('button', { name: 'Copy as text' }).click();
  const box = page.getByLabel('Select all and copy');
  await expect(box).toBeVisible();
  await expect(box).toHaveAttribute('readonly', '');
  await expect(box).toBeFocused();
  expect(await box.inputValue()).toMatch(/^Copy of the data card issued on .*; the PDF is the issued version\n\nData card/);
  await expect(page.getByRole('status').filter({ hasText: 'Copied.' })).toHaveCount(0);
});

test('FR-DOC-01 (MP-04): an issued mitigation plan lists, for a finding raised from a decision, the controls of its question\'s risk areas', async ({ baseURL }) => {
  // Workshop walk 2, N3: such a finding has no risk area of its own, and MP-04 printed "None". Issued as the owner seat, so the admin
  // seat's issue budget above is untouched.
  test.setTimeout(120_000);
  const base = `/api/v1/orgs/${org.slug}/projects`;
  const p = await api<{ id: string }>(baseURL!, 'owner', base, { requestId: randomUUID(), name: `N3 ${randomUUID().slice(0, 8)}`, aiSystemType: 'classification' });
  await api(baseURL!, 'assessor', `${base}/${p.id}/decisions`, {
    requestId: randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-12', baseVersionNumber: null, status: 'partly', scopeAnswer: null, optionsInPlace: [],
    reasonCode: null, reason: `End-to-end reason ${randomUUID()} for this decision.`, decidedBy: { kind: 'outside_role', role: 'principal_investigator' },
    declaredDate: '2026-10-30', evidenceIds: [],
  });
  const r = await api<{ id: string }>(baseURL!, 'admin', `${base}/${p.id}/reviews`, { requestId: randomUUID(), stage: 'pre-processing', preparedFor: null });
  const s = await api<{ id: string }>(baseURL!, 'reviewer', `${base}/${p.id}/reviews/${r.id}/seals`, { requestId: randomUUID() });
  const d = await api<{ id: string }>(baseURL!, 'owner', `${base}/${p.id}/reviews/${r.id}/documents`, {
    requestId: randomUUID(), documentType: 'mitigation_plan', sealId: s.id, typedFields: {},
  });
  const ctx = await pwRequest.newContext({ baseURL, storageState: seat('reviewer').storageStatePath });
  try {
    const res = await ctx.get(`/api/v1/orgs/${org.slug}/documents/${d.id}/text`);
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('Risk areas of question Q-PP-12: Labeling Bias (PP-07)'); // lane 6 C12: an area's name first, its code after (wordsThenCode)
    expect(text).toContain('Controls: C-03 Data Quality & Representativeness Audit; C-04 Bias Detection in Data; C-12 Labeling Quality Assurance');
  } finally {
    await ctx.dispose();
  }
});

test('FR-DOC-07 FR-REV-08: a 410 on Copy as text says the text was erased and refreshes the list', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  failOnDialog(page);
  const card = await sharedCard(baseURL!);
  await signIn(page, 'reviewer');
  await page.goto(s18Of(card));
  await page.route(textRoute(card.documentId), (route) => route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ error: 'erased', code: 'erased', erasedOn: '2026-11-04' }) }));
  const refreshed = page.waitForRequest((r) => r.url().includes('/documents') && r.url().includes('_rsc='));
  await page.getByRole('button', { name: 'Copy as text' }).click();
  await expect(page.getByRole('alert').filter({ hasText: DOCUMENTS_COPY.actions.copyErased })).toBeVisible();
  await refreshed;
});
