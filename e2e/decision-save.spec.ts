import { expect, test } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { applyNetworkProfile } from './helpers/network';
import {
  captureDecisionRequestIds, draftKeys, draftValues, fillValid, fixtureOrgId, openQuestion, questionPath, saveAlert, saveStatus, saveViaApi, seatOf, waitForQuestionPage,
} from './helpers/session';

/**
 * S-12's save path in the browser (FR-DEC-06, FR-DEC-07, NFR-REL-04, NFR-REL-05, NFR-PRIV-06, UX-24 to UX-27, UX-30,
 * M-01 to M-12): what the status line says for each outcome, what stays on the device and when a save is repeated.
 * Every project is new, so every question starts with no decision. Q is a fixture id.
 */
const Q = 'Q-PP-01';
const SAVED_V1 = /^Saved as version 1 at \d{2}:\d{2} \S+\. Decided by: you\. Entered by: you\.$/;

test.beforeEach(async ({ page }) => { failOnDialog(page); });

test('FR-DEC-06 NFR-REL-04 UX-25 M-01 M-03: Save shows Saving, then Saved as version 1 only after the reply', async ({ page, baseURL }) => {
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
  let release!: () => void;
  const held = new Promise<void>((res) => (release = res));
  await page.route('**/decisions', async (r) => { await held; await r.continue(); });
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText('Saving...');
  await expect(page.getByRole('button', { name: 'Save decision' })).toBeDisabled();
  release();
  await expect(saveStatus(page)).toHaveText(SAVED_V1);
  expect(await draftKeys(page)).toHaveLength(0);
});

test('FR-DEC-06 UX-25 M-05 NFR-REL-05: offline Save keeps the answer; reload online restores it; Retry saves it as version 1', async ({ page, context, baseURL }) => {
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page, { reason: 'Offline reason' });
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveAlert(page)).toHaveText('Not saved: connection lost. Your answer is kept on this device. Retry.');
  expect(await draftKeys(page)).toHaveLength(1);
  // The one automatic retry on reconnection (NFR-REL-05, its own test below) is kept from reaching the server here, so
  // this test sees the reload and the manual Retry alone.
  await page.route('**/decisions', (r) => r.abort('failed'));
  await context.setOffline(false); await page.reload(); await waitForQuestionPage(page);
  await page.unroute('**/decisions');
  await expect(page.getByLabel('Reason (required)')).toHaveValue('Offline reason');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(saveStatus(page)).toHaveText(/^Saved as version 1 at /);
  expect(await draftKeys(page)).toHaveLength(0);
});

test('NFR-REL-05: the answer survives a closed tab; a new page of the same account restores it', async ({ page, context, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  await page.getByLabel('Reason (required)').fill('Kept through a closed tab');
  await page.close();
  const again = await context.newPage();
  await openQuestion(again, 'assessor', Q, baseURL!, projectId);
  await expect(again.getByLabel('Reason (required)')).toHaveValue('Kept through a closed tab');
});

test('NFR-REL-05 UX-27: back online, the pending save is retried once with the same request id', async ({ page, context, baseURL }) => {
  const ids = captureDecisionRequestIds(page);
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
  await context.setOffline(true); await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveAlert(page)).toContainText('Not saved: connection lost.');
  await context.setOffline(false);
  await expect(saveStatus(page)).toHaveText(/^Saved as version 1 at /, { timeout: 10_000 });
  expect(new Set(ids.sent)).toEqual(new Set([ids.sent[0]]));
  expect(ids.sent.length).toBeLessThanOrEqual(2);
});

test('NFR-REL-05: a refusal is never retried by itself when the browser comes back online', async ({ page, context, baseURL }) => {
  const ids = captureDecisionRequestIds(page);
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
  await page.route('**/decisions', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'forbidden' }) }));
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveAlert(page)).toContainText('Not saved: your role in this organisation no longer allows this.');
  await context.setOffline(true); await context.setOffline(false);
  await page.waitForTimeout(1_000);
  expect(ids.sent).toHaveLength(1);
});

test('UX-27 FR-DEC-07 M-04: a reply lost after the server saved; Retry unchanged reuses the id and shows Already saved', async ({ page, baseURL }) => {
  const ids = captureDecisionRequestIds(page);
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
  await page.route('**/decisions', async (r) => { await r.fetch(); await r.abort('failed'); }, { times: 1 });   // the server commits, the page sees a failure
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveAlert(page)).toContainText('Not saved: connection lost.');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(saveStatus(page)).toHaveText(/^Already saved as version 1 at \d{2}:\d{2} \S+\.$/);
  expect(ids.sent[1]).toBe(ids.sent[0]);
});

test('UX-27: send, fail, edit, retry: the two requests carry different ids', async ({ page, baseURL }) => {
  const ids = captureDecisionRequestIds(page);
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
  await page.route('**/decisions', (r) => r.abort('failed'), { times: 1 });
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveAlert(page)).toContainText('Not saved: connection lost.');
  await page.getByLabel('Reason (required)').fill('Edited after the failure');
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText(/^Saved as version 1 at /);
  expect(ids.sent).toHaveLength(2);
  expect(ids.sent[1]).not.toBe(ids.sent[0]);
});

test('M-02 M-06: no reply for 10 seconds shows Still saving; 30 seconds shows Not saved, safe to retry', async ({ page, baseURL }) => {
  await page.clock.install();
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
  await page.route('**/decisions', () => new Promise(() => {}));   // never answers
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText('Saving...');
  await page.clock.fastForward(10_000);
  await expect(saveStatus(page)).toHaveText('Still saving. The connection is slow. Your answer is kept on this device.');
  await page.clock.fastForward(20_000);
  await expect(saveAlert(page)).toHaveText('Not saved: no reply from the server after 30 seconds. It may have arrived. Your answer is kept on this device. Retry is safe: it will not save twice.');
  await expect(saveStatus(page)).toHaveText('');
});

for (const [status, body, text] of [
  [500, { error: 'x', code: 'x' }, 'Not saved: the server had a problem. Your answer is kept on this device. Retry.'],   // M-07
  [403, { error: 'x', code: 'forbidden' }, 'Not saved: your role in this organisation no longer allows this. Your answer is kept on this device. Ask an owner or admin.'],   // M-09
  [409, { error: 'x', code: 'project_archived' }, 'Not saved: this project is archived. Owners and admins can unarchive it.'],   // M-12
  [401, { error: 'x', code: 'unauthenticated' }, 'Not saved: you have been signed out. Your answer is kept on this device. Sign in again to save it.'],   // M-08
] as const) {
  test(`UX-25 M-07 M-08 M-09 M-12: a ${status} ${body.code} reply shows its message once, assertively, and keeps the draft`, async ({ page, baseURL }) => {
    await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
    await page.route('**/decisions', (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
    await page.getByRole('button', { name: 'Save decision' }).click();
    await expect(saveAlert(page)).toHaveText(text);
    await expect(saveStatus(page)).toHaveText('');
    expect(await draftKeys(page)).toHaveLength(1);
    // F9: a refusal the server answered is not a pending save; only a 401 keeps the press, for Retry after signing in.
    const stored = JSON.parse((await draftValues(page))[0]) as { savePressedAt: string | null };
    expect(stored.savePressedAt === null).toBe(status !== 401);
    if (status === 401) {
      // B7: Sign in again returns to this question on this origin (SEC-2, always run; RF-3 drives the real sign-in).
      const path = new URL(page.url()).pathname;
      await expect(page.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', `/login?callbackUrl=${encodeURIComponent(path)}`);
    }
  });
}

test('CC-1 contract Error codes: a 403 acceptances_required keeps the draft and goes to S-05 with the question as callbackUrl', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page, { reason: 'Kept for after the acceptances' });
  await page.route('**/decisions', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'acceptances_required' }) }));
  // router.push fetches the page's server payload (an RSC request), not a document navigation.
  const went = page.waitForRequest((r) => new URL(r.url()).pathname === '/acceptances');
  await page.getByRole('button', { name: 'Save decision' }).click();
  const req = await went;
  expect(new URL(req.url()).searchParams.get('callbackUrl')).toBe(questionPath(projectId, Q));
  expect(await draftKeys(page)).toHaveLength(1);
});

test('CR-1 7.4.1: typing while a save is out is kept: the field keeps it and the draft stays, on the new version', async ({ page, baseURL }) => {
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page, { reason: 'Sent reason' });
  let release!: () => void;
  const held = new Promise<void>((res) => (release = res));
  await page.route('**/decisions', async (r) => { await held; await r.continue(); });
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText('Saving...');
  await page.getByLabel('Reason (required)').fill('Typed while it was saving');
  release();
  await expect(saveStatus(page)).toHaveText(/^Saved as version 1 at /);
  await expect(page.getByText('Starting from version 1')).toBeVisible();
  await expect(page.getByLabel('Reason (required)')).toHaveValue('Typed while it was saving');
  // UX-25 (ruling on CR-1): "Saved" is followed by the line that says the field holds a newer answer, on the device only.
  await expect(page.locator('[data-region="answer-form"] .save-status')).toContainText('Draft on this device, not saved yet');
  const stored = (await draftValues(page)).map((t) => JSON.parse(t) as { baseVersionNumber: number | null; value: { reason: string } });
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ baseVersionNumber: 1, value: { reason: 'Typed while it was saving' } });
});

/** A browser that cannot keep drafts (UX-26): every localStorage write throws, so the draft store's probe fails. */
async function blockStorage(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    Storage.prototype.setItem = function setItem() { throw new DOMException('Storage is blocked', 'SecurityError'); };
  });
}
const NO_STORAGE_LINE = 'This browser cannot keep drafts. Save before leaving this page.';

test('CR-1 UX-26: with no storage, typing while a save is out is kept when the new version arrives', async ({ page, baseURL }) => {
  await blockStorage(page);
  await openQuestion(page, 'assessor', Q, baseURL!);
  await expect(page.locator('[data-region="answer-form"] .save-status')).toContainText(NO_STORAGE_LINE);
  await fillValid(page, { reason: 'Sent reason' });
  let release!: () => void;
  const held = new Promise<void>((res) => (release = res));
  await page.route('**/decisions', async (r) => { await held; await r.continue(); });
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText('Saving...');
  await page.getByLabel('Reason (required)').fill('Typed while it was saving');
  release();
  await expect(saveStatus(page)).toHaveText(SAVED_V1);
  await expect(page.getByText('Starting from version 1')).toBeVisible();
  await expect(page.getByLabel('Reason (required)')).toHaveValue('Typed while it was saving');
});

test('CR-1 UX-26: with no storage, typing after Saved and before the new version arrives is kept', async ({ page, baseURL }) => {
  await blockStorage(page);
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  await fillValid(page, { reason: 'Sent reason' });
  // Hold the refresh that brings version 1 (an RSC request for this page), not the save itself.
  let release!: () => void;
  const held = new Promise<void>((res) => (release = res));
  const path = questionPath(projectId, Q);
  await page.route((u) => u.pathname === path, async (r) => { if (r.request().headers()['rsc'] === '1') await held; await r.continue(); });
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText(SAVED_V1);
  await expect(page.getByText('Starting from version 1')).toHaveCount(0);
  await page.getByLabel('Reason (required)').fill('Typed after it was saved');
  release();
  await expect(page.getByText('Starting from version 1')).toBeVisible();
  await expect(page.getByLabel('Reason (required)')).toHaveValue('Typed after it was saved');
});

for (const [code, text, label, target] of [
  ['acceptances_required', 'Not saved: accept the updated terms first, then come back.', 'Go to the terms', '/acceptances'],
  ['must_change_password', 'Not saved: change your password first, then come back.', 'Change password', '/change-password'],
] as const) {
  test(`CR-2 UX-26: with no storage, a 403 ${code} does not leave the page: the answer stays and the line links to ${target}`, async ({ page, baseURL }) => {
    await blockStorage(page);
    const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
    await fillValid(page, { reason: 'The only copy is in the field' });
    await page.route('**/decisions', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'x', code }) }));
    const left: string[] = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname === target) left.push(r.url()); });
    await page.getByRole('button', { name: 'Save decision' }).click();
    await expect(saveAlert(page)).toHaveText(`${text} ${NO_STORAGE_LINE}`);
    await expect(page.getByRole('link', { name: label })).toHaveAttribute('href', `${target}?callbackUrl=${encodeURIComponent(questionPath(projectId, Q))}`);
    await page.waitForTimeout(1_000);
    expect(left).toEqual([]);
    await expect(page.getByLabel('Reason (required)')).toHaveValue('The only copy is in the field');
  });
}

test('NFR-REL-05 B6: after an edit, coming back online sends nothing by itself', async ({ page, context, baseURL }) => {
  const ids = captureDecisionRequestIds(page);
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveAlert(page)).toContainText('Not saved: connection lost.');
  await page.getByLabel('Reason (required)').fill('Edited while offline');
  await context.setOffline(false);
  await page.waitForTimeout(2_000);
  expect(ids.sent).toHaveLength(1);   // the offline press only; the edited answer waits for Save
});

test('UX-24: typing for 60 seconds without Save sends no write', async ({ page, baseURL }) => {
  const writes: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.method() !== 'HEAD') writes.push(r.url()); });
  await page.clock.install();
  await openQuestion(page, 'assessor', Q, baseURL!);
  for (let i = 0; i < 6; i++) { await page.getByLabel('Reason (required)').pressSequentially('abc'); await page.clock.fastForward(10_000); }
  expect(writes.filter((u) => new URL(u).pathname.startsWith('/api/'))).toEqual([]);
  expect(await draftKeys(page)).toHaveLength(1);
});

test('UX-10 UX-12 M-11: 31 / 2 / 2026 and 4,001 characters are refused in the browser and nothing is sent', async ({ page, baseURL }) => {
  const writes = captureDecisionRequestIds(page);
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page, { reason: 'a'.repeat(4001), day: '31', month: '2', year: '2026' });
  await expect(page.getByText('4,001 / 4,000 characters')).toBeVisible();
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(page.getByText('There are 2 problems with this decision. Your answer is kept.')).toBeFocused();
  await expect(page.locator('#decision-declaredDate-error')).toHaveText('February has 28 days.');
  await expect(page.locator('#decision-reason-error')).toHaveText('The reason is 4,001 characters. The limit is 4,000.');
  await expect(page.getByRole('link', { name: /^Reason: / })).toHaveAttribute('href', '#decision-reason');
  expect(writes.sent).toEqual([]);
});

test('UX-10 FR-DEC-10: month and year only save with month precision; Same as version 2 fills the date', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  await fillValid(page, { day: '', month: '10', year: '2026' });
  const reply = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/decisions'));
  await page.getByRole('button', { name: 'Save decision' }).click();
  expect(((await (await reply).json()) as { declaredPrecision: string }).declaredPrecision).toBe('month');
  await expect(saveStatus(page)).toHaveText(/^Saved as version 1 at /);
  expect((await saveViaApi(baseURL!, 'owner', projectId, Q, { baseVersionNumber: 1, reason: 'Version 2 by the owner' })).status).toBe(201);
  await page.reload(); await waitForQuestionPage(page);
  for (const f of ['Day', 'Month', 'Year']) await expect(page.getByLabel(f, { exact: true })).toHaveValue('');
  await expect(page.getByText('Starting from version 2')).toBeVisible();
  await page.getByRole('button', { name: 'Same as version 2 (12 Oct 2026)' }).click();
  await expect(page.getByLabel('Day', { exact: true })).toHaveValue('12');
  await expect(page.getByLabel('Month', { exact: true })).toHaveValue('10');
  await expect(page.getByLabel('Year', { exact: true })).toHaveValue('2026');
  await expect(page.getByRole('button', { name: 'Same as my last save: Oct 2026' })).toBeVisible();
});

test('UX-09 UX-11 M-03: choosing Not yet shows the reason code; Ethics committee is named in the confirmation', async ({ page, baseURL }) => {
  await openQuestion(page, 'assessor', Q, baseURL!);
  await expect(page.getByRole('group', { name: 'Status' }).getByRole('radio')).toHaveCount(4);
  await expect(page.getByLabel('Reason code (required)')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Not yet', exact: true }).check();
  await page.getByLabel('Reason code (required)').selectOption('ny_planned_later');
  await fillValid(page, { status: null, decidedBy: 'Ethics committee' });
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText(/Decided by: Ethics committee\. Entered by: you\.$/);
});

test('UX-30: Save while a file is uploading waits; Save without it names the file left out', async ({ page, baseURL }) => {
  const ids = captureDecisionRequestIds(page);
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
  await applyNetworkProfile(page, 'Poor');
  await page.locator('input[type="file"]').setInputFiles({ name: 'costing-sheet.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2 * 1024 * 1024, 0x20)]) });
  await expect(page.getByText(/^Uploading costing-sheet\.pdf:/)).toBeVisible();
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(page.getByText('Waiting for costing-sheet.pdf to finish uploading.')).toBeVisible();
  expect(ids.sent).toEqual([]);
  const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/decisions'));
  await page.getByRole('button', { name: 'Save without it' }).click();
  expect(((await sent).postDataJSON() as { evidenceIds: string[] }).evidenceIds).toEqual([]);
  await expect(saveStatus(page)).toHaveText(/^Saved as version 1 at /, { timeout: 30_000 });
  await expect(page.getByText('Saved without costing-sheet.pdf. Add it in a new save once it has uploaded.')).toBeVisible();
  expect(ids.sent).toHaveLength(1);
});

test('NFR-PRIV-06 B3: the stored draft holds the form fields only, no file bytes', async ({ page, baseURL }) => {
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
  const v = JSON.parse((await draftValues(page))[0]) as { value: Record<string, unknown> };
  expect(Object.keys(v.value).sort()).toEqual(['date', 'decidedBy', 'evidenceIds', 'href', 'notUploaded', 'optionsInPlace', 'reason', 'reasonCode', 'scopeAnswer', 'status']);
});

test('UX-26 B2: the draft key holds the session\'s account, organisation, project and question', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  await page.getByLabel('Reason (required)').fill('x');
  const [key] = await draftKeys(page);
  expect(key).toBe(`makrai.draft.v1:${seatOf('assessor').userId}:${fixtureOrgId()}:${projectId}:q:${Q}`);
});
