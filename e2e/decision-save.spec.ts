import { expect, test, type Page } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { applyNetworkProfile } from './helpers/network';
import {
  captureDecisionRequestIds, draftKeys, draftValues, fillValid, fixtureOrgId, historyPath, openQuestion, questionPath, saveAlert, saveStatus, saveViaApi, seatOf, waitForQuestionPage,
} from './helpers/session';
import { problemSummary, savedLine } from '../lib/decision/copy';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { DECISION_OUTCOME_COPY } from '../lib/decision/outcome/copy';
import { FIELD_COPY } from '../lib/ui/field/copy';

/**
 * S-12's save path in the browser (FR-DEC-06, FR-DEC-07, NFR-REL-04, NFR-REL-05, NFR-PRIV-06, UX-24 to UX-27, UX-30,
 * M-01 to M-12): what the status line says for each outcome, what stays on the device and when a save is repeated.
 * Every project is new, so every question starts with no decision. Q is a fixture id.
 */
const Q = 'Q-PP-01';
const SAVED_V1 = /^Saved at \d{2}:\d{2} \S+ as version 1\. Decided by: you\.$/;

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
  await expect(saveAlert(page)).toHaveText(DECISION_OUTCOME_COPY.save.connection);
  expect(await draftKeys(page)).toHaveLength(1);
  // The one automatic retry on reconnection (NFR-REL-05, its own test below) is kept from reaching the server here, so
  // this test sees the reload and the manual Retry alone.
  await page.route('**/decisions', (r) => r.abort('failed'));
  await context.setOffline(false); await page.reload(); await waitForQuestionPage(page);
  await page.unroute('**/decisions');
  await expect(page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`)).toHaveValue('Offline reason');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 1, '.+')));
  expect(await draftKeys(page)).toHaveLength(0);
});

test('NFR-REL-05: the answer survives a closed tab; a new page of the same account restores it', async ({ page, context, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`).fill('Kept through a closed tab');
  await page.close();
  const again = await context.newPage();
  await openQuestion(again, 'assessor', Q, baseURL!, projectId);
  await expect(again.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`)).toHaveValue('Kept through a closed tab');
});

test('NFR-REL-05 UX-27: back online, the pending save is retried once with the same request id', async ({ page, context, baseURL }) => {
  const ids = captureDecisionRequestIds(page);
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
  await context.setOffline(true); await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveAlert(page)).toContainText(DECISION_OUTCOME_COPY.save.connection);
  await context.setOffline(false);
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 1, '.+')), { timeout: 10_000 });
  expect(new Set(ids.sent)).toEqual(new Set([ids.sent[0]]));
  expect(ids.sent.length).toBeLessThanOrEqual(2);
});

test('NFR-REL-05: a refusal is never retried by itself when the browser comes back online', async ({ page, context, baseURL }) => {
  const ids = captureDecisionRequestIds(page);
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
  await page.route('**/decisions', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'forbidden' }) }));
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveAlert(page)).toContainText(DECISION_OUTCOME_COPY.save.forbidden);
  await context.setOffline(true); await context.setOffline(false);
  await page.waitForTimeout(1_000);
  expect(ids.sent).toHaveLength(1);
});

test('UX-27 FR-DEC-07 M-04: a reply lost after the server saved; Retry unchanged reuses the id and shows Already saved', async ({ page, baseURL }) => {
  const ids = captureDecisionRequestIds(page);
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
  // WARNING: route.fetch() sends from Playwright's Node side, which ignores --host-resolver-rules. Under an image config
  // (baseURL https://makrai.org) it goes to the public site; copied into an image run it sent one POST there. Here the
  // baseURL is loopback. For an image run, fail the reply inside Chromium (CDP Fetch at the Response stage) and take
  // `test` from helpers/loopbackOnly, which refuses this call (__tests__/lint/e2e-loopback-guard.test.ts).
  await page.route('**/decisions', async (r) => { await r.fetch(); await r.abort('failed'); }, { times: 1 });   // the server commits, the page sees a failure
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveAlert(page)).toContainText(DECISION_OUTCOME_COPY.save.connection);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(saveStatus(page)).toHaveText(/^This was already saved at \d{2}:\d{2} \S+ \(version 1\)\.$/);
  expect(ids.sent[1]).toBe(ids.sent[0]);
});

test('UX-27: send, fail, edit, retry: the two requests carry different ids', async ({ page, baseURL }) => {
  const ids = captureDecisionRequestIds(page);
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
  await page.route('**/decisions', (r) => r.abort('failed'), { times: 1 });
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveAlert(page)).toContainText(DECISION_OUTCOME_COPY.save.connection);
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`).fill('Edited after the failure');
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 1, '.+')));
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
  await expect(saveStatus(page)).toHaveText(DECISION_OUTCOME_COPY.save.slow);
  await page.clock.fastForward(20_000);
  await expect(saveAlert(page)).toHaveText(DECISION_OUTCOME_COPY.save.noReply);
  await expect(saveStatus(page)).toHaveText('');
});

for (const [status, body, text] of [
  [500, { error: 'x', code: 'x' }, DECISION_OUTCOME_COPY.save.server],   // M-07
  [403, { error: 'x', code: 'forbidden' }, DECISION_OUTCOME_COPY.save.forbidden],   // M-09
  [409, { error: 'x', code: 'project_archived' }, DECISION_OUTCOME_COPY.save.archived],   // M-12
  [401, { error: 'x', code: 'unauthenticated' }, DECISION_OUTCOME_COPY.save.signedOut],   // M-08
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
      await expect(page.getByRole('link', { name: DECISION_FORM_COPY.signInAgain })).toHaveAttribute('href', `/login?callbackUrl=${encodeURIComponent(path)}`);
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
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`).fill('Typed while it was saving');
  release();
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 1, '.+')));
  await expect(page.getByText(DECISION_FORM_COPY.startingNote)).toBeVisible();
  await expect(page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`)).toHaveValue('Typed while it was saving');
  // UX-25 (ruling on CR-1): "Saved" is followed by the line that says the field holds a newer answer, on the device only.
  await expect(page.locator('[data-region="answer-form"] .save-status')).toContainText(DECISION_FORM_COPY.unsaved);
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
const NO_STORAGE_LINE = DECISION_FORM_COPY.noStorage;

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
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`).fill('Typed while it was saving');
  release();
  await expect(saveStatus(page)).toHaveText(SAVED_V1);
  await expect(page.getByText(DECISION_FORM_COPY.startingNote)).toBeVisible();
  await expect(page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`)).toHaveValue('Typed while it was saving');
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
  await expect(page.getByText(DECISION_FORM_COPY.startingNote)).toHaveCount(0);
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`).fill('Typed after it was saved');
  release();
  await expect(page.getByText(DECISION_FORM_COPY.startingNote)).toBeVisible();
  await expect(page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`)).toHaveValue('Typed after it was saved');
});

for (const [code, text, label, target] of [
  ['acceptances_required', DECISION_OUTCOME_COPY.gate.terms, DECISION_OUTCOME_COPY.gate.termsLink, '/acceptances'],
  ['must_change_password', DECISION_OUTCOME_COPY.gate.password, DECISION_OUTCOME_COPY.gate.passwordLink, '/change-password'],
] as const) {
  test(`CR-2 UX-26: with no storage, a 403 ${code} does not leave the page: the answer stays and the line links to ${target}`, async ({ page, baseURL }) => {
    await blockStorage(page);
    const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
    await fillValid(page, { reason: 'The only copy is in the field' });
    await page.route('**/decisions', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'x', code }) }));
    const left: string[] = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname === target) left.push(r.url()); });
    await page.getByRole('button', { name: 'Save decision' }).click();
    // The gate's line alone: "Save before leaving this page" is wrong where the person cannot save yet.
    await expect(saveAlert(page)).toHaveText(text);
    await expect(page.locator('[data-region="answer-form"] .save-status')).not.toContainText(NO_STORAGE_LINE);
    await expect(page.getByRole('link', { name: label })).toHaveAttribute('href', `${target}?callbackUrl=${encodeURIComponent(questionPath(projectId, Q))}`);
    await page.waitForTimeout(1_000);
    expect(left).toEqual([]);
    await expect(page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`)).toHaveValue('The only copy is in the field');
  });
}

test('CR-2 rr2: a draft write refused while the save is out leaves nothing on the device, so the 403 gate stays on the page', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  await fillValid(page, { reason: 'Pressed with storage working' });
  let release!: () => void;
  const held = new Promise<void>((res) => (release = res));
  let arrived!: () => void;
  const out = new Promise<void>((res) => (arrived = res));
  await page.route('**/decisions', async (r) => {
    arrived(); await held;
    await r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'acceptances_required' }) });
  });
  const left: string[] = [];
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/acceptances') left.push(r.url()); });
  await page.getByRole('button', { name: 'Save decision' }).click();
  await out;
  expect(await draftKeys(page)).toHaveLength(1);    // the press-time write worked
  // The quota fills while the save is out: the next write is refused, and the store removes the pressed draft.
  await page.evaluate(() => { Storage.prototype.setItem = function setItem() { throw new DOMException('full', 'QuotaExceededError'); }; });
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`).fill('A longer reason pasted while it was saving');
  expect(await draftKeys(page)).toHaveLength(0);
  release();
  await expect(saveAlert(page)).toHaveText(DECISION_OUTCOME_COPY.gate.terms);
  await expect(page.getByRole('link', { name: DECISION_OUTCOME_COPY.gate.termsLink })).toHaveAttribute('href', `/acceptances?callbackUrl=${encodeURIComponent(questionPath(projectId, Q))}`);
  await page.waitForTimeout(1_000);
  expect(left).toEqual([]);
  await expect(page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`)).toHaveValue('A longer reason pasted while it was saving');
});

test('NFR-REL-05 B6: after an edit, coming back online sends nothing by itself', async ({ page, context, baseURL }) => {
  const ids = captureDecisionRequestIds(page);
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveAlert(page)).toContainText(DECISION_OUTCOME_COPY.save.connection);
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`).fill('Edited while offline');
  await context.setOffline(false);
  await page.waitForTimeout(2_000);
  expect(ids.sent).toHaveLength(1);   // the offline press only; the edited answer waits for Save
});

test('UX-24: typing for 60 seconds without Save sends no write', async ({ page, baseURL }) => {
  const writes: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.method() !== 'HEAD') writes.push(r.url()); });
  await page.clock.install();
  await openQuestion(page, 'assessor', Q, baseURL!);
  for (let i = 0; i < 6; i++) { await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`).pressSequentially('abc'); await page.clock.fastForward(10_000); }
  expect(writes.filter((u) => new URL(u).pathname.startsWith('/api/'))).toEqual([]);
  expect(await draftKeys(page)).toHaveLength(1);
});

test('UX-10 UX-12 M-11: 31 / 2 / 2026 and 4,001 characters are refused in the browser and nothing is sent', async ({ page, baseURL }) => {
  const writes = captureDecisionRequestIds(page);
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page, { reason: 'a'.repeat(4001), day: '31', month: '2', year: '2026' });
  await expect(page.getByText('4,001 / 4,000 characters')).toBeVisible();
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(page.getByText(problemSummary(2))).toBeFocused();
  await expect(page.locator('#decision-declaredDate-error')).toHaveText('February has 28 days.');
  await expect(page.locator('#decision-reason-error')).toHaveText('The reason is 4,001 characters. The limit is 4,000.');
  await expect(page.getByRole('link', { name: new RegExp(`^${DECISION_FORM_COPY.fields.reason}: `) })).toHaveAttribute('href', '#decision-reason');
  expect(writes.sent).toEqual([]);
});

test('UX-10 FR-DEC-10: month and year only save with month precision; Same as version 2 fills the date', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  await fillValid(page, { day: '', month: '10', year: '2026' });
  const reply = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/decisions'));
  await page.getByRole('button', { name: 'Save decision' }).click();
  expect(((await (await reply).json()) as { declaredPrecision: string }).declaredPrecision).toBe('month');
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 1, '.+')));
  expect((await saveViaApi(baseURL!, 'owner', projectId, Q, { baseVersionNumber: 1, reason: 'Version 2 by the owner' })).status).toBe(201);
  await page.reload(); await waitForQuestionPage(page);
  for (const f of ['Day', 'Month', 'Year']) await expect(page.getByLabel(f, { exact: true })).toHaveValue('');
  await expect(page.getByText(DECISION_FORM_COPY.startingNote)).toBeVisible();
  await page.getByRole('button', { name: DECISION_FORM_COPY.sameAsCurrent('12 Oct 2026') }).click();
  await expect(page.getByLabel('Day', { exact: true })).toHaveValue('12');
  await expect(page.getByLabel('Month', { exact: true })).toHaveValue('10');
  await expect(page.getByLabel('Year', { exact: true })).toHaveValue('2026');
  await expect(page.getByRole('button', { name: DECISION_FORM_COPY.sameAsMyLast('Oct 2026') })).toBeVisible();
});

test('UX-09 UX-11 M-03: choosing Not yet shows the reason code; Ethics committee is named in the confirmation', async ({ page, baseURL }) => {
  await openQuestion(page, 'assessor', Q, baseURL!);
  await expect(page.getByRole('group', { name: 'Status' }).getByRole('radio')).toHaveCount(4);
  await expect(page.getByLabel(`${DECISION_FORM_COPY.fields.reasonCode} ${FIELD_COPY.required}`)).toHaveCount(0);
  await page.getByRole('radio', { name: 'Not yet', exact: true }).check();
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reasonCode} ${FIELD_COPY.required}`).selectOption('ny_planned_later');
  await fillValid(page, { status: null, decidedBy: 'Ethics committee' });
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveStatus(page)).toHaveText(/Decided by: Ethics committee\.$/);
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
  await page.getByRole('button', { name: DECISION_FORM_COPY.saveWithout(1) }).click();
  expect(((await sent).postDataJSON() as { evidenceIds: string[] }).evidenceIds).toEqual([]);
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 1, '.+')), { timeout: 30_000 });
  await expect(page.getByText(`${DECISION_FORM_COPY.savedWithout.before}costing-sheet.pdf${DECISION_FORM_COPY.savedWithout.after}`)).toBeVisible();
  expect(ids.sent).toHaveLength(1);
});

test('NFR-PRIV-06 B3: the stored draft holds the form fields only, no file bytes', async ({ page, baseURL }) => {
  await openQuestion(page, 'assessor', Q, baseURL!); await fillValid(page);
  const v = JSON.parse((await draftValues(page))[0]) as { value: Record<string, unknown> };
  expect(Object.keys(v.value).sort()).toEqual(['date', 'decidedBy', 'evidenceIds', 'href', 'notUploaded', 'optionsInPlace', 'reason', 'reasonCode', 'scopeAnswer', 'status']);
});

test('UX-26 B2: the draft key holds the session\'s account, organisation, project and question', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`).fill('x');
  const [key] = await draftKeys(page);
  expect(key).toBe(`makrai.draft.v1:${seatOf('assessor').userId}:${fixtureOrgId()}:${projectId}:q:${Q}`);
});

/**
 * UX-30, FR-EVD-01, FR-EVD-04: a file that finished uploading is attached to the answer that is saved. The block reports
 * the new id and the end of the upload in the same effect flush, and the second report must not undo the first.
 * Each case opens a new project, so the history it reads holds only its own versions.
 */
// Upload budget. The evidence route allows 10 POSTs a minute per account, links included (lib/rate-limit.ts:72), and index-0
// seats are shared: evidence-block.spec.ts uploads from assessor 0 (about 6 in a minute) and authz-api-matrix.spec.ts posts one
// link as every index-0 seat; evidence-block's M-19 spends admin 1. These cases therefore use the two index-1 seats nothing else
// uploads from (the fixture has no other index-1 seat that may upload). assessor 1: fill-upload-Save 1, upload-fill-Save 1, link 1,
// reload 1, two files 2 = 6 POSTs. owner 1: Save while uploading 1, typed during the wait 1, second version 2, failed upload 1 = 5
// (the cut-off upload never reaches the server). A retry re-runs one case on its seat, 2 POSTs at most, so 8 is the worst minute.
const evidencePdf = (name: string, size = 20 * 1024) => ({ name, mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(size - 9, 0x20)]) });
const isEvidencePost = (r: { request(): { method(): string }; url(): string }) => r.request().method() === 'POST' && /\/evidence$/.test(new URL(r.url()).pathname);
const isDecisionPost = (r: { method(): string; url(): string }) => r.method() === 'POST' && /\/decisions$/.test(new URL(r.url()).pathname);

/** Chooses `file` and returns the id the upload's 201 reply gave it, once the block says "Uploaded". */
async function uploadAndWait(page: Page, file: ReturnType<typeof evidencePdf>): Promise<string> {
  const reply = page.waitForResponse(isEvidencePost);
  await page.locator('input[type="file"]').setInputFiles(file);
  const res = await reply;
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  await expect(page.getByText(new RegExp(`^Uploaded ${file.name.replace('.', '\\.')} `))).toBeVisible();
  return id;
}
async function historyText(page: Page, projectId: string): Promise<string> {
  await page.goto(historyPath(projectId, Q));
  await expect(page.getByRole('heading', { level: 1, name: `History of ${Q}` })).toBeVisible();
  return (await page.locator('main').innerText());
}
async function draftEvidenceIds(page: Page): Promise<string[]> {
  const raw = (await draftValues(page))[0];
  return raw === undefined ? [] : (JSON.parse(raw) as { value: { evidenceIds: string[] } }).value.evidenceIds;
}

test('UX-30 FR-EVD-01: fill, upload a PDF, Save: the decision carries the file and the draft held it before Save', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!, undefined, 1); await fillValid(page);
  const id = await uploadAndWait(page, evidencePdf('kept-one.pdf'));
  await expect.poll(() => draftEvidenceIds(page)).toEqual([id]);
  const sent = page.waitForRequest(isDecisionPost);
  await page.getByRole('button', { name: 'Save decision' }).click();
  expect(((await sent).postDataJSON() as { evidenceIds: string[] }).evidenceIds).toEqual([id]);
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 1, '.+')));
  const text = await historyText(page, projectId);
  expect(text).toContain('kept-one.pdf');
  expect(text).not.toContain('Evidence\nNone');
});

test('UX-30 FR-EVD-01: upload first, then fill, Save: the decision carries the file', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!, undefined, 1);
  const id = await uploadAndWait(page, evidencePdf('kept-two.pdf'));
  await fillValid(page);
  const sent = page.waitForRequest(isDecisionPost);
  await page.getByRole('button', { name: 'Save decision' }).click();
  expect(((await sent).postDataJSON() as { evidenceIds: string[] }).evidenceIds).toEqual([id]);
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 1, '.+')));
  const text = await historyText(page, projectId);
  expect(text).toContain('kept-two.pdf');
  expect(text).not.toContain('Evidence\nNone');
});

test('UX-30: Save while the file is still uploading; the form sends by itself when it finishes, with the file', async ({ page, baseURL }) => {
  test.slow();   // the Poor profile makes the wait real; the 60 s steps below need more than the 30 s default
  const projectId = await openQuestion(page, 'owner', Q, baseURL!, undefined, 1); await fillValid(page);
  await applyNetworkProfile(page, 'Poor');
  const reply = page.waitForResponse(isEvidencePost);
  await page.locator('input[type="file"]').setInputFiles(evidencePdf('kept-three.pdf', 600 * 1024));
  await expect(page.getByText(/^Uploading kept-three\.pdf:/)).toBeVisible();
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(page.getByText('Waiting for kept-three.pdf to finish uploading.')).toBeVisible();
  const sent = page.waitForRequest(isDecisionPost, { timeout: 60_000 });
  const res = await reply;
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  expect(((await sent).postDataJSON() as { evidenceIds: string[] }).evidenceIds).toEqual([id]);
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 1, '.+')), { timeout: 60_000 });
  // The save that waited is the answer on screen: no draft is left behind and the form does not claim one.
  await expect(page.getByText(DECISION_FORM_COPY.unsaved)).toHaveCount(0);
  expect(await draftKeys(page)).toHaveLength(0);
  const text = await historyText(page, projectId);
  expect(text).toContain('kept-three.pdf');
  expect(text).not.toContain('Evidence\nNone');
});

test('UX-30: the answer on screen when the wait ends is what is saved, with the file', async ({ page, baseURL }) => {
  test.slow();   // the Poor profile makes the wait real; the 60 s steps below need more than the 30 s default
  const projectId = await openQuestion(page, 'owner', Q, baseURL!, undefined, 1); await fillValid(page);
  await applyNetworkProfile(page, 'Poor');
  const reply = page.waitForResponse(isEvidencePost);
  await page.locator('input[type="file"]').setInputFiles(evidencePdf('kept-five.pdf', 600 * 1024));
  await expect(page.getByText(/^Uploading kept-five\.pdf:/)).toBeVisible();
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(page.getByText('Waiting for kept-five.pdf to finish uploading.')).toBeVisible();
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`).fill('Typed while the save was waiting');
  const sent = page.waitForRequest(isDecisionPost, { timeout: 60_000 });
  const res = await reply;
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  const body = (await sent).postDataJSON() as { evidenceIds: string[]; reason: string };
  expect(body.reason).toBe('Typed while the save was waiting');
  expect(body.evidenceIds).toEqual([id]);
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 1, '.+')), { timeout: 60_000 });
  await expect(page.getByText(DECISION_FORM_COPY.unsaved)).toHaveCount(0);
  expect(await draftKeys(page)).toHaveLength(0);
  const text = await historyText(page, projectId);
  expect(text).toContain('kept-five.pdf');
  expect(text).toContain('Typed while the save was waiting');
});

test('UX-30 FR-EVD-04: version 2 carries the earlier file and the one uploaded since', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'owner', Q, baseURL!, undefined, 1); await fillValid(page);
  const first = await uploadAndWait(page, evidencePdf('kept-four-a.pdf'));
  let sent = page.waitForRequest(isDecisionPost);
  await page.getByRole('button', { name: 'Save decision' }).click();
  expect(((await sent).postDataJSON() as { evidenceIds: string[] }).evidenceIds).toEqual([first]);
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 1, '.+')));
  // FR-EVD-04: the new version starts from the previous version's evidence, which the block shows as attached.
  await expect(page.getByText('kept-four-a.pdf').first()).toBeVisible();
  const second = await uploadAndWait(page, evidencePdf('kept-four-b.pdf'));
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`).fill('Version 2 with a second file');
  sent = page.waitForRequest(isDecisionPost);
  await page.getByRole('button', { name: 'Save decision' }).click();
  expect([...((await sent).postDataJSON() as { evidenceIds: string[] }).evidenceIds].sort()).toEqual([first, second].sort());
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 2, '.+')));
  const text = await historyText(page, projectId);
  expect(text).toContain('kept-four-a.pdf');
  expect(text).toContain('kept-four-b.pdf');
});

test('FR-EVD-01 (control): a link alone is saved with the link\'s id', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!, undefined, 1); await fillValid(page);
  await page.getByRole('button', { name: 'Add a link' }).click();
  await page.getByLabel('Web address').fill('https://example.org/minutes');
  const reply = page.waitForResponse(isEvidencePost);
  await page.getByRole('button', { name: 'Add link', exact: true }).click();
  const { id } = (await (await reply).json()) as { id: string };
  const sent = page.waitForRequest(isDecisionPost);
  await page.getByRole('button', { name: 'Save decision' }).click();
  expect(((await sent).postDataJSON() as { evidenceIds: string[] }).evidenceIds).toEqual([id]);
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 1, '.+')));
  expect(await historyText(page, projectId)).toContain('https://example.org/minutes');
});

test('UX-30 FR-EVD-01: upload, reload, Save: the reloaded form holds the file and the save carries it', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!, undefined, 1); await fillValid(page);
  const id = await uploadAndWait(page, evidencePdf('kept-six.pdf'));
  await expect.poll(() => draftEvidenceIds(page)).toEqual([id]);
  await page.reload(); await waitForQuestionPage(page);
  // keptEvidenceLine (lib/question/draft.ts): the card the form shows for evidence the draft holds and the block does not.
  await expect(page.locator('[data-kept-evidence]')).toHaveText(new RegExp(DECISION_OUTCOME_COPY.keptEvidence(1)));
  const sent = page.waitForRequest(isDecisionPost);
  await page.getByRole('button', { name: 'Save decision' }).click();
  expect(((await sent).postDataJSON() as { evidenceIds: string[] }).evidenceIds).toEqual([id]);
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 1, '.+')));
  await expect(page.getByText(DECISION_FORM_COPY.unsaved)).toHaveCount(0);
  expect(await draftKeys(page)).toHaveLength(0);
  expect(await historyText(page, projectId)).toContain('kept-six.pdf');
});

test('UX-30: Save while two files are uploading sends once, after both finished, with both ids', async ({ page, baseURL }) => {
  test.slow();
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!, undefined, 1); await fillValid(page);
  await applyNetworkProfile(page, 'Poor');
  const ids: string[] = [];
  let finished = 0;
  let finishedAtSend = -1;
  let posts = 0;
  page.on('response', (r) => { if (isEvidencePost(r) && r.status() === 201) { finished++; void r.json().then((b: { id: string }) => ids.push(b.id)); } });
  page.on('request', (r) => { if (isDecisionPost(r)) { posts++; finishedAtSend = finished; } });
  await page.locator('input[type="file"]').setInputFiles([evidencePdf('kept-seven-a.pdf', 150 * 1024), evidencePdf('kept-seven-b.pdf', 450 * 1024)]);
  await expect(page.getByText(/^Uploading kept-seven-/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(page.locator('[data-upload-wait]')).toBeVisible();
  // A partial finish must not send: the smaller file is done, the larger still moves, the wait card stays and nothing was posted.
  await expect(page.getByText(/^Uploaded kept-seven-a\.pdf /)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^Uploading kept-seven-b\.pdf:/)).toBeVisible();
  await expect(page.locator('[data-upload-wait]')).toBeVisible();
  expect(posts).toBe(0);
  const sent = page.waitForRequest(isDecisionPost, { timeout: 60_000 });
  const body = (await sent).postDataJSON() as { evidenceIds: string[] };
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 1, '.+')), { timeout: 60_000 });
  expect(posts).toBe(1);
  expect(finishedAtSend).toBe(2);
  await expect.poll(() => ids.length).toBe(2);
  expect([...body.evidenceIds].sort()).toEqual([...ids].sort());
  await expect(page.getByText(DECISION_FORM_COPY.unsaved)).toHaveCount(0);
  expect(await draftKeys(page)).toHaveLength(0);
  const text = await historyText(page, projectId);
  expect(text).toContain('kept-seven-a.pdf');
  expect(text).toContain('kept-seven-b.pdf');
});

test('UX-30: a failed upload is never waited out by itself; Save without it leaves it out and names it', async ({ page, context, baseURL }) => {
  const projectId = await openQuestion(page, 'owner', Q, baseURL!, undefined, 1); await fillValid(page);
  const good = await uploadAndWait(page, evidencePdf('kept-eight-ok.pdf'));
  const bodies: Array<{ evidenceIds: string[] }> = [];
  page.on('request', (r) => { if (isDecisionPost(r)) bodies.push(r.postDataJSON() as { evidenceIds: string[] }); });
  await context.setOffline(true);
  await page.locator('input[type="file"]').setInputFiles(evidencePdf('kept-eight-bad.pdf'));
  await expect(page.getByText('Not uploaded: connection lost.')).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(page.getByText('Waiting for kept-eight-bad.pdf to finish uploading.')).toBeVisible();
  expect(bodies).toEqual([]);
  const sent = page.waitForRequest(isDecisionPost);
  await page.getByRole('button', { name: DECISION_FORM_COPY.saveWithout(1) }).click();
  expect(((await sent).postDataJSON() as { evidenceIds: string[] }).evidenceIds).toEqual([good]);
  await expect(saveStatus(page)).toHaveText(new RegExp(savedLine('.+', 1, '.+')));
  await expect(page.getByText(`${DECISION_FORM_COPY.savedWithout.before}kept-eight-bad.pdf${DECISION_FORM_COPY.savedWithout.after}`)).toBeVisible();
  expect(bodies).toHaveLength(1);
  const text = await historyText(page, projectId);
  expect(text).toContain('kept-eight-ok.pdf');
  expect(text).not.toContain('kept-eight-bad.pdf');
});
