import { expect, test } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { draftKeys, expectMovedOn, fillValid, openQuestion, questionPath, saveViaApi, waitForQuestionPage } from './helpers/session';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { REASON_OPTIONAL } from '../lib/decision/copy';

/**
 * W-4 in the browser (FR-DEC-05, UX-26, UX-28, M-10, NFR-A11Y-03): a save over a version someone saved after the person
 * started is refused, both versions are shown, and nothing is merged.
 */
const Q = 'Q-PP-01';

test.beforeEach(async ({ page }) => { failOnDialog(page); });

test('FR-DEC-05 UX-28 M-10 NFR-A11Y-03: a colleague saved version 2 first: both reasons, who saved, focus on the announced heading', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  expect((await saveViaApi(baseURL!, 'assessor', projectId, Q, { reason: 'Version 1' })).status).toBe(201);
  await page.reload(); await waitForQuestionPage(page);
  await fillValid(page, { reason: 'Mine' });
  expect((await saveViaApi(baseURL!, 'owner', projectId, Q, { baseVersionNumber: 1, reason: 'Owner saved first' })).status).toBe(201);
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(page.getByRole('heading', { name: DECISION_FORM_COPY.conflict.heading })).toBeFocused({ timeout: 15_000 });
  await expect(page.locator('[data-region="conflict"]').getByText(/^.+ saved a newer version at \d{2}:\d{2} \S+\. Compare it with your version, then choose what to keep\.$/)).toBeVisible();
  await expect(page.locator('[data-region="conflict"]').getByRole('heading', { name: DECISION_FORM_COPY.conflict.saved(2), exact: true })).toBeVisible();
  await expect(page.locator('[data-region="conflict"]').getByText('Owner saved first', { exact: true })).toBeVisible();
  await expect(page.locator('[data-region="conflict"]').getByText('Mine', { exact: true })).toBeVisible();
  const reply = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/decisions'));
  await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.saveMine }).click();
  expect(((await (await reply).json()) as { versionNumber: number }).versionNumber).toBe(3);   // "save mine" makes version 3 over the colleague's version 2
  await expectMovedOn(page, Q, 'Supervisor');   // a new version keeps the earlier decider (the owner's "Keep earlier decider")
  expect(await draftKeys(page)).toHaveLength(0);
});

test('UX-28: Discard mine deletes the draft and shows the newer version', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  await fillValid(page, { reason: 'Mine to discard' });
  expect((await saveViaApi(baseURL!, 'owner', projectId, Q, { reason: 'Owner first' })).status).toBe(201);
  await page.getByRole('button', { name: 'Save decision' }).click();
  await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.discardMine }).click();
  await expect(page.getByRole('heading', { name: DECISION_FORM_COPY.conflict.heading })).toHaveCount(0);
  expect(await draftKeys(page)).toHaveLength(0);
  await expect(page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${REASON_OPTIONAL}`)).toHaveValue('Owner first');
  await expect(page.getByText(DECISION_FORM_COPY.startingNote)).toBeVisible();
});

test('UX-28: Edit mine first returns to the form with the draft and the new base', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  await fillValid(page, { reason: 'Mine to edit' });
  expect((await saveViaApi(baseURL!, 'owner', projectId, Q, { reason: 'Owner first' })).status).toBe(201);
  await page.getByRole('button', { name: 'Save decision' }).click();
  await page.getByRole('button', { name: DECISION_FORM_COPY.conflict.editMine }).click();
  await expect(page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${REASON_OPTIONAL}`)).toHaveValue('Mine to edit');
  await expect(page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${REASON_OPTIONAL}`)).toBeFocused();
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${REASON_OPTIONAL}`).fill('Mine, edited');
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expectMovedOn(page, Q);
});

test('UX-26: a draft based on version 1 reopened after a colleague saved version 2 shows W-4 at once', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  expect((await saveViaApi(baseURL!, 'assessor', projectId, Q, { reason: 'Version 1' })).status).toBe(201);
  await page.reload(); await waitForQuestionPage(page);
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${REASON_OPTIONAL}`).fill('My draft on version 1');
  await page.goto('about:blank');
  expect((await saveViaApi(baseURL!, 'owner', projectId, Q, { baseVersionNumber: 1, reason: 'Owner version 2' })).status).toBe(201);
  await page.goto(questionPath(projectId, Q)); await waitForQuestionPage(page);
  await expect(page.getByRole('heading', { name: DECISION_FORM_COPY.conflict.heading })).toBeVisible();
  await expect(page.locator('[data-region="conflict"]').getByText('My draft on version 1', { exact: true })).toBeVisible();
  await expect(page.locator('[data-region="conflict"]').getByText('Owner version 2', { exact: true })).toBeVisible();
});

test('M-10: the same account on another device: the text says so', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  await fillValid(page, { reason: 'From this device' });
  expect((await saveViaApi(baseURL!, 'assessor', projectId, Q, { reason: 'From another device' })).status).toBe(201);
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(page.locator('[data-region="conflict"]').getByText(/^You saved a newer version at \d{2}:\d{2} \S+\. Compare it with your version, then choose what to keep\.$/)).toBeVisible();
});
