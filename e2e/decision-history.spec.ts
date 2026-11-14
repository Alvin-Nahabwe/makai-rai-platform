import { expect, test, type Page } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { HOSTILE_STRINGS } from '../__tests__/helpers/hostile';
import { failOnDialog } from './helpers/dialogs';
import { actAsSeat, fillValid, fixtureOrgSlug, historyPath, newProject, questionPath, saveStatus, saveViaApi, seatRequest, stagePath, waitForQuestionPage } from './helpers/session';
import { REQUEST_MESSAGES, WITHDRAW_COPY, deciderLabel } from '../lib/decision/copy';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { FIELD_COPY } from '../lib/ui/field/copy';

/**
 * S-13 and the withdrawal (FR-DEC-04, FR-DEC-08, FR-CNT-07, UX-14, UX-29, UX-40, UX-42, NFR-SEC-11; owner question B21).
 * Versions are saved through route 1 as the named seat; every project is new. Q is a fixture id.
 */
const Q = 'Q-PP-01';

test.beforeEach(async ({ page }) => { failOnDialog(page); });

async function openHistory(page: Page, role: OrgRole, projectId: string) {
  await actAsSeat(page, role);
  const res = await page.goto(historyPath(projectId, Q));
  await expect(page.getByRole('heading', { level: 1, name: `History of ${Q}` })).toBeVisible();
  return res;
}
async function twoVersions(baseURL: string, role: OrgRole = 'assessor'): Promise<string> {
  const projectId = await newProject(baseURL);
  expect((await saveViaApi(baseURL, role, projectId, Q, { reason: 'Version 1' })).status).toBe(201);
  expect((await saveViaApi(baseURL, role, projectId, Q, { baseVersionNumber: 1, reason: 'Version 2', status: 'partly' })).status).toBe(201);
  return projectId;
}
const withdrawStatus = (page: Page) => page.locator('[data-withdraw-status]');

test('FR-DEC-04 (screen) FR-DEC-08: three versions in reverse order; after withdrawal the question reads No decision and S-13 shows all three', async ({ page, baseURL }) => {
  const projectId = await twoVersions(baseURL!);
  await openHistory(page, 'assessor', projectId);
  await page.getByRole('button', { name: 'Withdraw this decision' }).click();
  await page.getByLabel(`${WITHDRAW_COPY.codeLabel} ${FIELD_COPY.required}`).selectOption('duplicate');
  await page.getByLabel(`${WITHDRAW_COPY.reasonLabel} ${FIELD_COPY.required}`).fill('Duplicate of Q-PP-02.');
  await page.getByRole('button', { name: 'Withdraw decision' }).press('Enter');
  await expect(withdrawStatus(page)).toHaveText('Withdrawn. The question has no current decision.');
  await expect(page.locator('[data-version-number]')).toHaveCount(3);
  // F12: the control is gone once the withdrawal arrives, and focus is on the result, not on the page.
  await expect(withdrawStatus(page)).toBeFocused();
  expect(await page.locator('[data-version-number]').evaluateAll((els) => els.map((e) => e.getAttribute('data-version-number')))).toEqual(['3', '2', '1']);
  const v3 = page.locator('[data-version-number="3"]');
  await expect(v3).toContainText('Withdrawn: Duplicate');
  await expect(v3).toContainText('Duplicate of Q-PP-02.');
  const v2 = page.locator('[data-version-number="2"]');
  for (const part of ['Partly', 'Version 2', `${deciderLabel({ kind: 'outside_role', role: 'supervisor' }, '', 'record')}, 12 Oct 2026`, 'Entered by']) await expect(v2).toContainText(part);
  // CONSOLIDATED section 4: the content version and the "Show UTC" disclosure are internal and are not shown.
  for (const gone of ['0.0.1-fixture', 'Content version', 'Show UTC']) await expect(v2).not.toContainText(gone);
  await page.goto(stagePath(projectId, 'pre-processing'));
  await expect(page.locator(`[data-question-id="${Q}"] .status-label`)).toHaveText('No decision');
});

test('UX-29 UX-42 FR-DEC-08: the withdrawal confirmation names the version and the consequence, takes focus, and Cancel returns it', async ({ page, baseURL }) => {
  await openHistory(page, 'assessor', await twoVersions(baseURL!));
  const trigger = page.getByRole('button', { name: 'Withdraw this decision' });
  await trigger.focus(); await page.keyboard.press('Enter');
  await expect(page.getByText(WITHDRAW_COPY.objectName(2, 'Q-PP-01'))).toBeVisible();
  await expect(page.getByText('The question returns to "no decision". Every version stays in the history.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw decision' })).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.closest('[data-inline-confirm]') !== null)).toBe(true);
  await page.getByRole('button', { name: 'Cancel' }).press('Enter');
  await expect(trigger).toBeFocused();
});

test('FR-DEC-08: Withdraw is absent for an assessor on another member\'s entry, and for reviewers and viewers', async ({ page, baseURL }) => {
  const projectId = await twoVersions(baseURL!, 'owner');
  for (const role of ['assessor', 'reviewer', 'viewer'] as const) {
    await openHistory(page, role, projectId);
    await expect(page.getByRole('button', { name: 'Withdraw this decision' })).toHaveCount(0);
  }
  await openHistory(page, 'admin', projectId);
  await expect(page.getByRole('button', { name: 'Withdraw this decision' })).toHaveCount(1);
});

test('FR-DEC-04 (screen) UX-31: a version in seal 1 is marked In seal 1, and a later version is not', async ({ page, baseURL }) => {
  const projectId = await twoVersions(baseURL!);
  // Open a stage review and seal it through REV-b's routes, as the owner.
  const owner = await seatRequest(baseURL!, 'owner');
  try {
    const review = await owner.post(`/api/v1/orgs/${fixtureOrgSlug()}/projects/${projectId}/reviews`, { data: { requestId: crypto.randomUUID(), stage: 'pre-processing', preparedFor: null } });
    expect(review.status(), 'open review').toBe(201);
    const { id: reviewId, name } = (await review.json()) as { id: string; name: string };
    const seal = await owner.post(`/api/v1/orgs/${fixtureOrgSlug()}/projects/${projectId}/reviews/${reviewId}/seals`, { data: { requestId: crypto.randomUUID() } });
    expect(seal.status(), 'seal').toBe(201);
    expect((await saveViaApi(baseURL!, 'assessor', projectId, Q, { baseVersionNumber: 2, reason: 'Version 3, after the seal' })).status).toBe(201);
    await openHistory(page, 'viewer', projectId);
    await expect(page.locator('[data-version-number="2"]')).toContainText(`In seal 1 of ${name}`);
    await expect(page.locator('[data-version-number="1"]')).not.toContainText('In seal');
    await expect(page.locator('[data-version-number="3"]')).not.toContainText('In seal');
  } finally {
    await owner.dispose();
  }
});

test('FR-DEC-08 UX-25 (screen): the withdrawal shows Withdrawing..., then Withdrawn. The question has no current decision.', async ({ page, baseURL }) => {
  await openHistory(page, 'assessor', await twoVersions(baseURL!));
  let release!: () => void;
  const held = new Promise<void>((res) => (release = res));
  await page.route('**/withdrawal', async (r) => { await held; await r.continue(); });
  await page.getByRole('button', { name: 'Withdraw this decision' }).click();
  await page.getByLabel(`${WITHDRAW_COPY.codeLabel} ${FIELD_COPY.required}`).selectOption('duplicate');
  await page.getByLabel(`${WITHDRAW_COPY.reasonLabel} ${FIELD_COPY.required}`).fill('Duplicate of Q-PP-02.');
  await page.getByRole('button', { name: 'Withdraw decision' }).click();
  await expect(withdrawStatus(page)).toHaveText('Withdrawing...');
  release();
  await expect(withdrawStatus(page)).toHaveText('Withdrawn. The question has no current decision.');
});

test('FR-DEC-08: a withdrawal needs a withdrawal code and a reason, and sends nothing without them', async ({ page, baseURL }) => {
  const sent: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/withdrawal')) sent.push(r.url()); });
  await openHistory(page, 'assessor', await twoVersions(baseURL!));
  await page.getByRole('button', { name: 'Withdraw this decision' }).click();
  await page.getByRole('button', { name: 'Withdraw decision' }).click();
  await expect(page.locator('#withdraw-code-error')).toHaveText(REQUEST_MESSAGES.withdrawalCode);
  await expect(page.locator('#withdraw-reason-error')).toContainText('Write a reason.');
  expect(sent).toEqual([]);
});

test('UX-40 FR-DEC-04 (screen): a history of 21 versions shows the latest 20 and Show older', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  for (let i = 0; i < 21; i++) {
    expect((await saveViaApi(baseURL!, 'assessor', projectId, Q, { baseVersionNumber: i === 0 ? null : i, reason: `Version ${i + 1}` })).status).toBe(201);
  }
  await openHistory(page, 'viewer', projectId);
  await expect(page.locator('[data-version-number]')).toHaveCount(20);
  await page.getByRole('link', { name: 'Show older' }).click();
  await expect(page.locator('[data-version-number]')).toHaveCount(21);
});

test('UX-14 FR-DEC-01 (owner question B21): S-12 and S-13 opened by address as a viewer answer 200; S-12 shows the one line and no form', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  expect((await saveViaApi(baseURL!, 'assessor', projectId, Q, { reason: 'Version 1' })).status).toBe(201);
  await actAsSeat(page, 'viewer');
  const s12 = await page.goto(questionPath(projectId, Q));
  expect(s12!.status()).toBe(200);
  await waitForQuestionPage(page);
  await expect(page.getByText('Only owners, admins and assessors record decisions.')).toBeVisible();
  await expect(page.locator('[data-region="answer-form"] form')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Status' })).toHaveCount(0);
  const s13 = await openHistory(page, 'viewer', projectId);
  expect(s13!.status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Withdraw this decision' })).toHaveCount(0);
});

test('NFR-SEC-11: hostile reason text shows as text on S-12 and S-13 and opens no dialog', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  let base: number | null = null;
  for (const s of HOSTILE_STRINGS) {
    const r = await saveViaApi(baseURL!, 'assessor', projectId, Q, { baseVersionNumber: base, reason: s });
    expect(r.status).toBe(201);
    base = r.body.versionNumber;
  }
  await openHistory(page, 'viewer', projectId);
  for (const s of HOSTILE_STRINGS) await expect(page.getByText(s, { exact: true })).toBeVisible();   // failOnDialog is armed in beforeEach
  await actAsSeat(page, 'assessor');
  await page.goto(questionPath(projectId, Q)); await waitForQuestionPage(page);
  await expect(page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`)).toHaveValue(HOSTILE_STRINGS[HOSTILE_STRINGS.length - 1]);
});

test('F12: on S-12 the withdrawal result takes focus, and a new decision saved after it clears that line', async ({ page, baseURL }) => {
  const projectId = await twoVersions(baseURL!);
  await actAsSeat(page, 'assessor');
  await page.goto(questionPath(projectId, Q));
  await waitForQuestionPage(page);
  await page.locator('details.more-menu summary').click();
  await page.getByRole('button', { name: 'Withdraw this decision' }).click();
  await page.getByLabel(`${WITHDRAW_COPY.codeLabel} ${FIELD_COPY.required}`).selectOption('duplicate');
  await page.locator('#withdraw-reason').fill('Duplicate of Q-PP-02.');
  await page.getByRole('button', { name: 'Withdraw decision' }).press('Enter');
  await expect(withdrawStatus(page)).toHaveText('Withdrawn. The question has no current decision.');
  // The refresh brought the withdrawn version: the More menu is gone and the result line holds focus.
  await expect(page.locator('details.more-menu')).toHaveCount(0);
  await expect(withdrawStatus(page)).toBeFocused();
  // A new decision on the same page, without a reload: the withdrawal's line no longer describes the question.
  await fillValid(page, { reason: 'Decided again after the withdrawal' });
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText(/^Saved at .+ as version 4\./);
  await expect(page.locator('details.more-menu')).toHaveCount(1);
  await expect(page.getByText('Withdrawn. The question has no current decision.')).toHaveCount(0);
});
