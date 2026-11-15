import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { HOSTILE_STRINGS } from '../__tests__/helpers/hostile';
import {
  addAcceptedRisk, addFinding, addMitigationVersion, addProject, buildOrg, type FixtureAccount, type OrgFixture,
} from '../__tests__/helpers/recordFixture';
import { testDb } from '../__tests__/helpers/db';
import { escapeRe } from '../__tests__/helpers/escapeRe';
import type { Stage } from '../types/record';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { expectCountsAsWholeNumbersPerStage, expectStatusMarksInk } from './helpers/noScore';
import { PROJECT_COPY } from '../lib/project/copy';
import { PROJECT_FORM_COPY } from '../lib/project/form/copy';
import { PROJECT_WRITE_COPY } from '../lib/project/write/copy';
import { PROJECT_FIELD_MESSAGES } from '../lib/projects/copy';
import { LIFECYCLE_STAGE_WORDS } from '../lib/project/labels';
import { UI_COPY } from '../lib/ui/copy';

/**
 * The project screens in a browser: S-08 (dashboard), S-09 (new and edit project), S-10 (stage view) and S-32 (all
 * projects). Keyboard, inline confirmation, retry-safe writes, contrast and reflow at three widths in both themes,
 * no-script delivery, hostile text and sentinel counts (FR-PRJ-01 to 04, UX-06, UX-27, UX-29, UX-36, NFR-A11Y-02,
 * NFR-A11Y-05, NFR-INT-02, NFR-SEC-11, FR-RM-04). The organisation and its projects are made with K0a's record fixture
 * builder; each case signs in on the login page as a fixture account, as e2e/fup-screens.spec.ts does.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN = randomUUID().slice(0, 8);
const KEYBOARD_NAME = `Maternal-risk triage ${RUN}`;

let fx: OrgFixture;
let main: { id: string };
let keyboardProject: { id: string };
let retryProject: { id: string };
let emptyProject: { id: string };
let hostileProject: { id: string };
const shelved: Array<{ id: string }> = [];
const contexts: BrowserContext[] = [];

let ipSeq = 0;
const nextClientIp = () => `10.78.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

async function signedIn(browser: Browser, account: Pick<FixtureAccount, 'email' | 'password'>): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': nextClientIp() } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto('/login');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
  return page;
}

/** The `requestId` of each POST or PATCH body sent to an address matching `pattern`, aborted requests included. */
function requestIdsOf(page: Page, pattern: RegExp): string[] {
  const ids: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' || !pattern.test(new URL(r.url()).pathname)) return;
    ids.push((JSON.parse(r.postData() ?? '{}') as { requestId: string }).requestId);
  });
  return ids;
}

/** Presses Tab until the focused control's accessible name matches, failing after 60 presses. */
async function tabUntil(page: Page, name: RegExp): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press('Tab');
    const found = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return '';
      return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
    });
    if (name.test(found)) return;
  }
  throw new Error(`tabUntil: no focus stop matched ${name} in 60 presses`);
}

const path = (rest: string) => `/orgs/${fx.org.slug}${rest}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  fx = await buildOrg({ label: 'prj' });
  main = await addProject(fx, { name: `PRJ main ${RUN}` });
  keyboardProject = await addProject(fx, { name: KEYBOARD_NAME });
  retryProject = await addProject(fx, { name: `PRJ retry ${RUN}` });
  emptyProject = await addProject(fx, { name: `PRJ empty ${RUN}` });
  hostileProject = await addProject(fx, { name: HOSTILE_STRINGS[0] });
  shelved.push(await addProject(fx, { name: `PRJ shelved one ${RUN}`, archived: true }));
  shelved.push(await addProject(fx, { name: `PRJ shelved two ${RUN}`, archived: true }));
  const finding = await addFinding(fx, main.id, { stage: 'pre-processing', source: 'team' });
  // The owner owns one overdue mitigation, so S-08 has a status label and an Overdue label to check.
  await addMitigationVersion(fx, finding.id, { status: 'planned', owner: 'owner', dueDate: '2020-01-01' });
  // One decision in each stage, through the route with the owner's own session, so each column has recorded counts.
  const owner = await signedIn(browser, fx.members.owner);
  for (const [stage, questionId] of [['pre-processing', 'Q-PP-01'], ['in-processing', 'Q-IP-01'], ['post-processing', 'Q-PO-01']]) {
    const res = await owner.context().request.post(`/api/v1/orgs/${fx.org.slug}/projects/${main.id}/decisions`, {
      headers: { origin: new URL(owner.url()).origin },
      data: {
        requestId: randomUUID(), stage, questionId, baseVersionNumber: null, status: 'done', scopeAnswer: null, optionsInPlace: [],
        reasonCode: null, reason: `Seeded reason ${randomUUID()} for this decision.`, decidedBy: { kind: 'outside_role', role: 'principal_investigator' },
        declaredDate: '2026-10-30', evidenceIds: [],
      },
    });
    if (!res.ok()) throw new Error(`seeding ${questionId} answered ${res.status()}: ${await res.text()}`);
  }
});

test.afterAll(async () => {
  await Promise.all(contexts.map((c) => c.close()));
});

test('UX-36 FR-PRJ-02: S-10 delivers its headings and counts with JavaScript off', async ({ browser }) => {
  const signed = await signedIn(browser, fx.members.owner);
  const state = await signed.context().storageState();
  const context = await browser.newContext({ javaScriptEnabled: false, storageState: state });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(path(`/projects/${main.id}`));
  for (const h of ['Pre-processing', 'In-processing', 'Post-processing']) await expect(page.getByRole('heading', { name: h })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: /\d+ questions? with no decision/ }).first()).toBeVisible();
});

test('UX-06: to-do counts come before recorded counts; status is words in ink, with no tick and no green (S-10 and S-08)', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path(`/projects/${main.id}`));
  const text = await page.locator('[data-stage="pre-processing"]').innerText();
  expect(text.indexOf('with no decision')).toBeGreaterThan(-1);
  expect(text.indexOf('with no decision')).toBeLessThan(text.indexOf('Recorded so far'));
  for (const p of [path(`/projects/${main.id}`), path('/dashboard')]) {
    await page.goto(p);
    await expectStatusMarksInk(page);
  }
});

test('NFR-A11Y-02 FR-PRJ-03: keyboard only, an owner opens S-10, archives with the inline confirmation, and sees the banner', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner);
  // From the projects list: Home now shows one project's stages (plan 1B Task 10), not a card per project.
  await page.goto(path('/projects'));
  // Anchored to the whole text: the kit Table's focusable scroll region also holds the name in its text, and Enter does nothing there.
  await tabUntil(page, new RegExp(`^${escapeRe(KEYBOARD_NAME)}$`));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/projects/${keyboardProject.id}$`));
  await tabUntil(page, /^Archive project$/);
  await expectFocusVisibleAndUncovered(page);
  await page.keyboard.press('Enter');
  await tabUntil(page, /^Archive project$/);
  await page.keyboard.press('Enter');
  await expect(page.getByText('This project is archived.')).toBeVisible();
});

test('UX-29 FR-PRJ-03: the archive confirmation names the project and the consequence, and its button repeats the action', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path(`/projects/${emptyProject.id}`));
  await page.getByRole('button', { name: 'Archive project' }).click();
  await expect(page.getByText(`Archive PRJ empty ${RUN}?`)).toBeVisible();
  await expect(page.getByText('Nothing in it can be changed until it is unarchived. No reminders are sent. Its issued documents stay stored and can still be downloaded.')).toBeVisible();
  await expect(page.getByText('Its documents still check as genuine.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Archive project' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Archive project' })).toBeFocused();
});

test('UX-29 FR-PRJ-03: archiving shows "Archiving..." then the archived line; a lost connection offers Retry with the same request id', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path(`/projects/${retryProject.id}`));
  const ids = requestIdsOf(page, /\/archive$/);
  await page.route('**/archive', (r) => r.abort('internetdisconnected'));
  await page.getByRole('button', { name: 'Archive project' }).click();
  await page.getByRole('button', { name: 'Archive project' }).last().click();
  await expect(page.getByRole('status').filter({ hasText: PROJECT_WRITE_COPY.archive.lost })).toBeVisible();
  await page.unroute('**/archive');
  await page.route('**/archive', async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue(); });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText(PROJECT_WRITE_COPY.archive.archiving)).toBeVisible();
  await expect(page.getByText(PROJECT_WRITE_COPY.archive.archived)).toBeVisible();
  await expect(page.getByText(PROJECT_COPY.archivedBanner)).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(ids[0]).toMatch(UUID_V4);
  expect(ids[1]).toBe(ids[0]);
});

/**
 * After an answer the archive control's container has focus (not the page body), and keeps it once the refresh that
 * follows has rendered the archived page: polled, so a focus moved after the commit is waited for, not sampled once.
 */
async function expectFocusOnArchiveControl(page: Page): Promise<void> {
  await expect(page.locator('.archive-control')).toBeFocused();
  await expect(page.getByText(PROJECT_COPY.archivedBanner)).toBeVisible();
  await expect(page.locator('.archive-control')).toBeFocused();
}

test('L5-4 D-398: Archive opens on Cancel; while the request is held the confirm button keeps focus and is aria-busy; after success focus is inside the control', async ({ browser }) => {
  const name = `PRJ focus held ${RUN}`;
  const project = await addProject(fx, { name });
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path(`/projects/${project.id}`));
  const ids = requestIdsOf(page, /\/archive$/);
  let release = () => {};
  const held = new Promise<void>((ok) => { release = ok; });
  await page.route('**/archive', async (r) => { await held; await r.continue(); });
  await page.getByRole('button', { name: PROJECT_WRITE_COPY.archive.trigger }).click();
  const confirmation = page.getByRole('group', { name: PROJECT_WRITE_COPY.archive.objectName(name) });
  await expect(confirmation.getByRole('button', { name: UI_COPY.confirm.cancel })).toBeFocused();
  await page.keyboard.press('Tab');
  const confirm = confirmation.getByRole('button', { name: PROJECT_WRITE_COPY.archive.action });
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText(PROJECT_WRITE_COPY.archive.archiving)).toBeVisible();
  await expect(confirm).toBeFocused();
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Enter');   // a second press on the busy confirm button sends nothing (register D-386)
  release();
  await expect(page.getByText(PROJECT_WRITE_COPY.archive.archived)).toBeVisible();
  await expectFocusOnArchiveControl(page);
  expect(ids).toHaveLength(1);
});

test('L5-4 L5-15: while the archive request is held, Cancel does nothing: the confirmation stays open and its button busy', async ({ browser }) => {
  const name = `PRJ cancel held ${RUN}`;
  const project = await addProject(fx, { name });
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path(`/projects/${project.id}`));
  let release = () => {};
  const held = new Promise<void>((ok) => { release = ok; });
  await page.route('**/archive', async (r) => { await held; await r.continue(); });
  await page.getByRole('button', { name: PROJECT_WRITE_COPY.archive.trigger }).click();
  const confirmation = page.getByRole('group', { name: PROJECT_WRITE_COPY.archive.objectName(name) });
  const confirm = confirmation.getByRole('button', { name: PROJECT_WRITE_COPY.archive.action });
  await confirm.click();
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await confirmation.getByRole('button', { name: UI_COPY.confirm.cancel }).click();
  await expect(confirmation).toBeVisible();
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  release();
  await expect(page.getByText(PROJECT_WRITE_COPY.archive.archived)).toBeVisible();
});

test('L5-4 D-398: after a failed archive focus is on Retry, and stays on Retry, aria-busy, while its own request is held', async ({ browser }) => {
  const name = `PRJ focus retry ${RUN}`;
  const project = await addProject(fx, { name });
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path(`/projects/${project.id}`));
  let release = () => {};
  const held = new Promise<void>((ok) => { release = ok; });
  let sends = 0;
  await page.route('**/archive', async (r) => { if (sends++ === 0) { await r.abort('internetdisconnected'); return; } await held; await r.continue(); });
  await page.getByRole('button', { name: PROJECT_WRITE_COPY.archive.trigger }).click();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: PROJECT_WRITE_COPY.archive.lost })).toBeVisible();
  const retry = page.getByRole('button', { name: PROJECT_WRITE_COPY.archive.retry, exact: true });
  await expect(retry).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText(PROJECT_WRITE_COPY.archive.archiving)).toBeVisible();
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  release();
  await expect(page.getByText(PROJECT_WRITE_COPY.archive.archived)).toBeVisible();
  await expectFocusOnArchiveControl(page);
});

test('L5-4 D-398: after a failed unarchive focus is on Retry, and stays on Retry, aria-busy, while its own request is held', async ({ browser }) => {
  const name = `PRJ focus unarchive ${RUN}`;
  await addProject(fx, { name, archived: true });
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path('/projects'));
  let release = () => {};
  const held = new Promise<void>((ok) => { release = ok; });
  let sends = 0;
  await page.route('**/unarchive', async (r) => { if (sends++ === 0) { await r.abort('internetdisconnected'); return; } await held; await r.continue(); });
  const button = page.getByRole('button', { name: PROJECT_WRITE_COPY.unarchive.named(name) });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: PROJECT_WRITE_COPY.unarchive.lost })).toBeVisible();
  const retry = page.locator('#projects-list tr', { hasText: name }).getByRole('button', { name: PROJECT_WRITE_COPY.unarchive.retry, exact: true });
  await expect(retry).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  release();
  await expect(page.getByRole('button', { name: PROJECT_WRITE_COPY.unarchive.named(name) })).toHaveCount(0);
  // ruling L5-13 (plan 1B Task 12, one list): the success after a Retry leaves focus on the list, where the project is now an
  // active row, not on the body
  await expect(page.locator('#projects-list tr', { hasText: name }).locator('.projects-list__state')).toHaveText(PROJECT_COPY.allProjects.active);
  await expect(page.locator('#projects-list [role="region"]')).toBeFocused();
});

test('L5-4 L5-13: after a successful unarchive the row says Active and focus is on the projects list, not the page body; the pressed button shows the kit\'s spinner while its request is held', async ({ browser }) => {
  const name = `PRJ focus unarchived ${RUN}`;
  await addProject(fx, { name, archived: true });
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path('/projects'));
  let release = () => {};
  const held = new Promise<void>((ok) => { release = ok; });
  await page.route('**/unarchive', async (r) => { await held; await r.continue(); });
  const button = page.getByRole('button', { name: PROJECT_WRITE_COPY.unarchive.named(name) });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-busy', 'true');
  await expect(button.locator('.ui-button__spinner[aria-hidden="true"]')).toHaveCount(1);
  await expect(button).toBeFocused();
  release();
  await expect(page.locator('#projects-list tr', { hasText: name }).locator('.projects-list__state')).toHaveText(PROJECT_COPY.allProjects.active);
  await expect(page.locator('#projects-list [role="region"]')).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  // design review 16: the list's status line says what happened, after the refresh, and the focused region shows its ring
  await expect(page.locator('#projects-list .projects-list__status[role="status"]')).toHaveText(PROJECT_WRITE_COPY.unarchive.unarchived(name));
  expect(await page.locator('#projects-list [role="region"]').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
});

/** The list's status line on S-32 (design review 16): one polite line above the table. */
const listStatus = (page: Page) => page.locator('#projects-list .projects-list__status[role="status"]');
const rowOf = (page: Page, name: string) => page.locator('#projects-list tr', { hasText: name });

test('re-review N1: the Unarchive sentence appears only once the refreshed list shows the row as Active, with no Unarchive button', async ({ browser }) => {
  const name = `PRJ announce after refresh ${RUN}`;
  await addProject(fx, { name, archived: true });
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path('/projects'));
  // hold the refresh (the RSC request of this page) so the moment between the 204 and the new list can be seen
  let release = () => {};
  const held = new Promise<void>((ok) => { release = ok; });
  let refreshes = 0;
  await page.route((url) => url.pathname === path('/projects'), async (r) => {
    if (r.request().headers().rsc === '1') { refreshes += 1; await held; }
    await r.continue();
  });
  await page.getByRole('button', { name: PROJECT_WRITE_COPY.unarchive.named(name) }).click();
  await expect.poll(() => refreshes).toBeGreaterThan(0);
  // the 204 has landed and the refresh is held: the row still reads Archived, so the line says nothing yet
  await expect(rowOf(page, name).locator('.projects-list__state')).toHaveText(PROJECT_COPY.allProjects.archived);
  await expect(listStatus(page)).toHaveText('');
  release();
  await expect(listStatus(page)).toHaveText(PROJECT_WRITE_COPY.unarchive.unarchived(name));
  // at the moment the sentence is there, the row reads Active and offers no Unarchive
  expect(await rowOf(page, name).locator('.projects-list__state').textContent()).toBe(PROJECT_COPY.allProjects.active);
  await expect(page.getByRole('button', { name: PROJECT_WRITE_COPY.unarchive.named(name) })).toHaveCount(0);
  await expect(page.locator('#projects-list [role="region"]')).toBeFocused();
});

test('re-review N2: a 409 not_archived (another person unarchived it first) is announced once the row is Active', async ({ browser }) => {
  const name = `PRJ announce not archived ${RUN}`;
  const p = await addProject(fx, { name, archived: true });
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path('/projects'));
  // another session unarchives it first, from this page's own origin and cookies
  const status = await page.evaluate(async (url) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID() }) })).status,
    `/api/v1/orgs/${fx.org.slug}/projects/${p.id}/unarchive`);
  expect(status).toBe(204);
  const answers: number[] = [];
  page.on('response', (r) => { if (r.url().endsWith('/unarchive')) answers.push(r.status()); });
  await page.getByRole('button', { name: PROJECT_WRITE_COPY.unarchive.named(name) }).click();
  await expect(listStatus(page)).toHaveText(PROJECT_WRITE_COPY.unarchive.unarchived(name));
  expect(answers).toEqual([409]);
  await expect(rowOf(page, name).locator('.projects-list__state')).toHaveText(PROJECT_COPY.allProjects.active);
});

test('re-review N2: a 409 request_id_reused and a 409 that is not the API\'s JSON never announce, and the row stays Archived', async ({ browser }) => {
  const name = `PRJ announce refused ${RUN}`;
  await addProject(fx, { name, archived: true });
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path('/projects'));
  // request_id_reused: the API's own error body; nothing was written, the page refreshes and still lists it archived
  await page.route('**/unarchive', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'conflict', code: 'request_id_reused' }) }));
  let refreshed = false;
  page.on('request', (r) => { if (r.headers().rsc === '1') refreshed = true; });
  await page.getByRole('button', { name: PROJECT_WRITE_COPY.unarchive.named(name) }).click();
  await expect.poll(() => refreshed).toBe(true);
  await page.waitForLoadState('networkidle');
  await expect(rowOf(page, name).locator('.projects-list__state')).toHaveText(PROJECT_COPY.allProjects.archived);
  await expect(listStatus(page)).toHaveText('');
  // a 409 whose body is not the API's JSON: the outcome is not known, so the row's own line says so and offers Retry
  await page.unroute('**/unarchive');
  await page.route('**/unarchive', (r) => r.fulfill({ status: 409, contentType: 'text/html', body: '<html>conflict</html>' }));
  await page.getByRole('button', { name: PROJECT_WRITE_COPY.unarchive.named(name) }).click();
  await expect(page.getByRole('status').filter({ hasText: PROJECT_WRITE_COPY.unarchive.lost })).toBeVisible();
  await expect(listStatus(page)).toHaveText('');
});

test('UX-27 L5-14: after a successful create the form stays busy until the new page has loaded, and a second Enter sends nothing', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto(path('/projects/new'));
  const ids = requestIdsOf(page, /\/api\/v1\/orgs\/[^/]+\/projects$/);
  let release = () => {};
  const held = new Promise<void>((ok) => { release = ok; });
  // hold the navigation to the new project's page (its server component payload), not the create request itself
  await page.route((url) => /\/orgs\/[^/]+\/projects\/[0-9a-f-]{36}$/.test(url.pathname), async (r) => { await held; await r.continue(); });
  await page.getByLabel('Project name').fill(`Held navigation ${RUN}`);
  await page.getByRole('button', { name: PROJECT_FORM_COPY.create }).click();
  await expect.poll(() => ids.length).toBe(1);
  await page.waitForTimeout(500);   // the create has answered; the navigation is held
  await page.getByLabel('Project name').press('Enter');
  await page.locator('form button[type="submit"]').click();
  await page.waitForTimeout(500);
  expect(ids).toHaveLength(1);
  await expect(page.getByRole('button', { name: PROJECT_FORM_COPY.creating })).toHaveAttribute('aria-busy', 'true');
  release();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  expect(ids).toHaveLength(1);
});

test('NFR-A11Y-05 (motion): the project form\'s details do not animate on page load, and do after the person opens them', async ({ browser }) => {
  const project = await addProject(fx, { name: `PRJ motion ${RUN}` });
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path(`/projects/${project.id}/edit`));
  const details = page.locator('#project-details');
  await expect(details).toBeVisible();
  expect(await details.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await page.getByRole('button', { name: PROJECT_FORM_COPY.hideDetails }).click();
  await expect(details).toBeHidden();
  await page.getByRole('button', { name: PROJECT_FORM_COPY.showDetails }).click();
  await expect(details).toBeVisible();
  expect(await details.evaluate((el) => getComputedStyle(el).animationName)).not.toBe('none');
});

test('UX-27 NFR-INT-02: S-09 keeps its request id when the same form is sent again after a lost connection, and takes a new one once a field is edited', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto(path('/projects/new'));
  const ids = requestIdsOf(page, /\/api\/v1\/orgs\/[^/]+\/projects$/);
  let posts = 0;
  await page.route('**/api/v1/orgs/*/projects', (r) => (r.request().method() === 'POST' && posts++ < 2 ? r.abort('internetdisconnected') : r.continue()));
  await page.getByLabel('Project name').fill('Retry probe');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByText(PROJECT_FORM_COPY.noReply.create)).toBeVisible();
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByText(PROJECT_FORM_COPY.noReply.create)).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
  await page.getByLabel('Project name').fill('Retry probe, edited');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  expect(ids).toHaveLength(3);
  expect(ids[2]).not.toBe(ids[0]);
});

test('UX-27 (M-02): create, archive and unarchive each say "Still saving. The connection is slow." when the server is held past 10 seconds', async ({ browser }) => {
  test.setTimeout(150_000);
  const SLOW = PROJECT_FORM_COPY.slow;   // the form's line; Archive and Unarchive say their own (archive.slow, unarchive.slow)
  const hold = async (route: import('@playwright/test').Route) => { await new Promise((ok) => setTimeout(ok, 11_500)); await route.continue(); };
  const toArchive = await addProject(fx, { name: `PRJ slow archive ${RUN}` });
  const shelvedSlow = await addProject(fx, { name: `PRJ slow unarchive ${RUN}`, archived: true });
  const owner = await signedIn(browser, fx.members.owner);

  await owner.goto(path('/projects/new'));
  await owner.route('**/api/v1/orgs/*/projects', (r) => (r.request().method() === 'POST' ? hold(r) : r.continue()));
  await owner.getByLabel('Project name').fill(`Slow create ${RUN}`);
  await owner.getByRole('button', { name: 'Create project' }).click();
  await expect(owner.getByRole('status').filter({ hasText: SLOW })).toBeVisible({ timeout: 20_000 });
  await owner.waitForURL(/\/projects\/[0-9a-f-]{36}$/);

  await owner.goto(path(`/projects/${toArchive.id}`));
  await owner.route('**/archive', hold);
  await owner.getByRole('button', { name: 'Archive project' }).click();
  await owner.getByRole('button', { name: 'Archive project' }).last().click();
  await expect(owner.getByRole('status').filter({ hasText: PROJECT_WRITE_COPY.archive.slow })).toBeVisible({ timeout: 20_000 });
  await expect(owner.getByText(PROJECT_WRITE_COPY.archive.archived)).toBeVisible({ timeout: 20_000 });

  await owner.goto(path('/projects'));
  await owner.route('**/unarchive', hold);
  await owner.getByRole('button', { name: `Unarchive ${`PRJ slow unarchive ${RUN}`}` }).click();
  await expect(owner.getByRole('status').filter({ hasText: PROJECT_WRITE_COPY.unarchive.slow })).toBeVisible({ timeout: 20_000 });
  await expect(owner.getByRole('button', { name: `Unarchive ${`PRJ slow unarchive ${RUN}`}` })).toHaveCount(0, { timeout: 20_000 });
  void shelvedSlow;
});

test('SPEC-2 F8: a 422 on a field in the closed details opens them and shows the message beside the field and in the summary; a 403 on Archive keeps its line and disables the button', async ({ browser }) => {
  const owner = await signedIn(browser, fx.members.owner);
  await owner.goto(path('/projects/new'));
  await owner.getByLabel('Project name').fill(`Too long sector ${RUN}`);
  await owner.getByRole('button', { name: PROJECT_FORM_COPY.showDetails }).click();
  await owner.getByLabel('Sector').fill('s'.repeat(201));
  await owner.getByRole('button', { name: PROJECT_FORM_COPY.hideDetails }).click();   // close the section again
  await owner.getByRole('button', { name: 'Create project' }).click();
  // the kit's error summary is not a live region: its title takes focus after the refused submit, which is how a reader hears it
  await expect(owner.getByRole('heading', { name: PROJECT_WRITE_COPY.summary(1) })).toBeFocused();
  await expect(owner.getByLabel('Sector')).toBeVisible();   // the section was opened for the person
  await expect(owner.locator('#deploymentSector-error')).toHaveText(PROJECT_FIELD_MESSAGES.textMax(200));
  await expect(owner.getByLabel('Sector')).toHaveAttribute('aria-describedby', 'deploymentSector-error');

  await owner.goto(path(`/projects/${emptyProject.id}`));
  await owner.route('**/archive', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Forbidden', code: 'forbidden' }) }));
  await owner.getByRole('button', { name: 'Archive project' }).click();
  await owner.getByRole('button', { name: 'Archive project' }).last().click();
  await expect(owner.getByRole('status').filter({ hasText: PROJECT_WRITE_COPY.forbidden })).toBeVisible();
  await expect(owner.getByRole('button', { name: 'Archive project' })).toBeDisabled();
  await expect(owner.locator('.archive-control')).toBeFocused();   // ruling L5-4: the stop path leaves focus on the control's container
});

test('FR-PRJ-01: an assessor creates a project with every descriptive field and edits one; S-10 shows both', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto(path('/projects/new'));
  await page.getByLabel('Project name').fill(`Described ${RUN}`);
  await page.getByLabel('AI system type').selectOption('classification');
  await page.getByRole('button', { name: PROJECT_FORM_COPY.showDetails }).click();
  await page.getByLabel('Sector').fill('health');
  await page.getByLabel('Dataset type').fill('tabular');
  await page.getByLabel('Dataset size').selectOption('medium_1k_100k');
  await page.getByLabel(PROJECT_FORM_COPY.labels.processesPersonalData).selectOption('true');
  await page.getByLabel('Funding source').fill('GIZ');
  await page.getByLabel('Regulatory context').fill('A national data-protection act');
  await page.getByLabel(PROJECT_FORM_COPY.labels.developmentStage).selectOption('development');
  // the two dates are the kit's DateField: three boxes each (plan 1B Task 13)
  await page.locator('#projectStart-day').fill('1');
  await page.locator('#projectStart-month').fill('9');
  await page.locator('#projectStart-year').fill('2026');
  await page.locator('#projectEnd-day').fill('31');
  await page.locator('#projectEnd-month').fill('3');
  await page.locator('#projectEnd-year').fill('2027');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByText(['Classification', 'health', PROJECT_COPY.descriptive.usesPersonalData, LIFECYCLE_STAGE_WORDS.development].join(', '))).toBeVisible();
  await page.getByRole('link', { name: 'Edit project' }).click();
  await expect(page.locator('#projectStart-day')).toHaveValue('1');   // the stored dates come back into the boxes
  await expect(page.locator('#projectEnd-year')).toHaveValue('2027');
  await page.getByLabel(PROJECT_FORM_COPY.labels.developmentStage).selectOption('testing');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByText(['Classification', 'health', PROJECT_COPY.descriptive.usesPersonalData, LIFECYCLE_STAGE_WORDS.testing].join(', '))).toBeVisible();
});

test('FR-PRJ-01 (defect 21): choosing Other shows its text field, the saved project shows the text, and choosing another type clears it', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto(path('/projects/new'));
  await page.getByLabel('Project name').fill(`Other type ${RUN}`);
  const other = page.getByLabel(PROJECT_FORM_COPY.labels.aiSystemTypeOther);
  await expect(other).toHaveCount(0);
  await page.getByLabel('AI system type').selectOption('other');
  await expect(other).toBeVisible();
  await expect(other).not.toBeFocused();   // the new field does not take focus
  await other.fill(`Rules engine ${RUN}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByText(`Rules engine ${RUN}`)).toBeVisible();
  await page.getByRole('link', { name: 'Edit project' }).click();
  await expect(page.getByLabel(PROJECT_FORM_COPY.labels.aiSystemTypeOther)).toHaveValue(`Rules engine ${RUN}`);
  await page.getByLabel('AI system type').selectOption('classification');
  await expect(page.getByLabel(PROJECT_FORM_COPY.labels.aiSystemTypeOther)).toHaveCount(0);
  const sent = page.waitForRequest((r) => r.method() === 'PATCH' && /\/api\/v1\/orgs\/[^/]+\/projects\/[0-9a-f-]{36}$/.test(r.url()));
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await sent).postDataJSON()).toMatchObject({ aiSystemType: 'classification', aiSystemTypeOther: null });
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByText(`Rules engine ${RUN}`)).toHaveCount(0);
});

test('FR-PRJ-01 (B row 98): an empty name and an incomplete date are refused before anything is sent, beside each field and in the summary', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto(path('/projects/new'));
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/v1\/orgs\/[^/]+\/projects$/.test(r.url())) posts.push(r.url()); });
  await page.getByRole('button', { name: PROJECT_FORM_COPY.showDetails }).click();
  await page.locator('#projectStart-day').fill('1');
  await page.locator('#projectStart-year').fill('2026');
  await page.getByRole('button', { name: PROJECT_FORM_COPY.hideDetails }).click();   // closed again: the date's error opens it
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: PROJECT_WRITE_COPY.summary(2) })).toBeFocused();
  const summary = page.locator('.ui-error-summary');
  await expect(summary.getByRole('link')).toHaveText([PROJECT_FORM_COPY.nameRequired, PROJECT_FORM_COPY.dateInvalid]);
  await expect(summary.getByRole('link', { name: PROJECT_FORM_COPY.dateInvalid })).toHaveAttribute('href', '#projectStart-day');
  await expect(page.locator('#name-error')).toHaveText(PROJECT_FORM_COPY.nameRequired);
  await expect(page.getByLabel('Project name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Project name')).toHaveAttribute('aria-describedby', 'name-error');
  await expect(page.locator('#projectStart-error')).toHaveText(PROJECT_FORM_COPY.dateInvalid);
  await expect(page.locator('#projectStart-day')).toBeVisible();   // the details opened themselves
  await expect(page.getByRole('button', { name: PROJECT_FORM_COPY.hideDetails })).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(300);
  expect(posts).toHaveLength(0);
});

test('FR-PRJ-01 (review F1): Team size text that is not a whole number is refused by the server beside the field, not dropped', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto(path('/projects/new'));
  await page.getByLabel('Project name').fill(`Team size range ${RUN}`);
  await page.getByRole('button', { name: PROJECT_FORM_COPY.showDetails }).click();
  await page.getByLabel(PROJECT_FORM_COPY.labels.teamSize).fill('5-10');
  await page.getByRole('button', { name: PROJECT_FORM_COPY.hideDetails }).click();   // closed again: the refusal opens it
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: PROJECT_WRITE_COPY.summary(1) })).toBeFocused();
  await expect(page.locator('#project-details')).toBeVisible();
  await expect(page.locator('#teamSize-error')).toHaveText(PROJECT_FIELD_MESSAGES.teamSize);
  await expect(page.getByLabel(PROJECT_FORM_COPY.labels.teamSize)).toHaveValue('5-10');
  expect(page.url()).toMatch(/\/projects\/new$/);
  await page.getByLabel(PROJECT_FORM_COPY.labels.teamSize).fill('12');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
});

test('Task 13 item 6 (fix round 2): the primary button comes before Cancel at 375 and 1280 px, on screen and for the keyboard', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(path('/projects/new'));
    const create = page.getByRole('button', { name: PROJECT_FORM_COPY.create });
    const cancel = page.getByRole('link', { name: PROJECT_FORM_COPY.cancel, exact: true });
    const a = await create.boundingBox();
    const b = await cancel.boundingBox();
    if (a === null || b === null) throw new Error(`no box for the actions at ${width}px`);
    if (width === 375) expect(a.y + a.height, `Create project above Cancel at ${width}px`).toBeLessThanOrEqual(b.y);
    else {
      expect(Math.abs(a.y - b.y), `one row at ${width}px`).toBeLessThan(a.height);
      expect(a.x + a.width, `Create project left of Cancel at ${width}px`).toBeLessThanOrEqual(b.x);
    }
    await page.getByRole('button', { name: PROJECT_FORM_COPY.showDetails }).click();
    await page.getByLabel(PROJECT_FORM_COPY.labels.targetPopulation).focus();   // the last field
    await page.keyboard.press('Tab');
    await expect(create).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
  }
});

test('defect 22: the toggle says Show more details while closed and Hide more details while open, and aria-expanded follows', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto(path('/projects/new'));
  const show = page.getByRole('button', { name: PROJECT_FORM_COPY.showDetails });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await expect(show).toHaveAttribute('aria-controls', 'project-details');
  await expect(page.locator('#project-details')).toBeHidden();
  await show.click();
  const hide = page.getByRole('button', { name: PROJECT_FORM_COPY.hideDetails });
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('region', { name: PROJECT_FORM_COPY.sectionDetails })).toBeVisible();
  await hide.click();
  await expect(page.getByRole('button', { name: PROJECT_FORM_COPY.showDetails })).toHaveAttribute('aria-expanded', 'false');
});

test('UX-27 NFR-INT-02: S-32 sends Unarchive with a request id and keeps it across a Retry', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path('/projects'));
  const before = await page.getByRole('button', { name: 'Unarchive' }).count();
  const ids = requestIdsOf(page, /\/unarchive$/);
  let sends = 0;
  await page.route('**/unarchive', (r) => (sends++ < 1 ? r.abort('internetdisconnected') : r.continue()));
  await page.getByRole('button', { name: 'Unarchive' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: PROJECT_WRITE_COPY.unarchive.lost })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unarchive' })).toHaveCount(before - 1);
  expect(ids).toHaveLength(2);
  expect(ids[0]).toMatch(UUID_V4);
  expect(ids[1]).toBe(ids[0]);
});

test('FR-PRJ-03: a project that an owner archived leaves S-08 and is listed as archived on S-32', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.viewer);
  await page.goto(path('/dashboard'));
  await expect(page.getByText(`PRJ shelved one ${RUN}`)).toHaveCount(0);
  await page.goto(path('/projects'));
  await expect(page.getByText(`PRJ shelved two ${RUN}`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unarchive' })).toHaveCount(0);
});

test('FR-PRJ-02: a new project\'s S-10 shows the 7.4.2 empty texts in each stage', async ({ browser }) => {
  const empty = await addProject(fx, { name: `PRJ fresh ${RUN}` });
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path(`/projects/${empty.id}`));
  await expect(page.getByText('No decisions recorded yet', { exact: true })).toHaveCount(3);
  await expect(page.getByText(PROJECT_COPY.noOverdue)).toHaveCount(3);   // each line's Still open (Route R5)
  await expect(page.getByText('No stage review yet.')).toHaveCount(3);
});

for (const width of [1280, 360, 320]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`NFR-A11Y-05 UX-32: S-08, S-09, S-10 and S-32 at ${width}px, ${theme}: no serious violation, no horizontal scroll`, async ({ browser }) => {
      test.setTimeout(120_000);
      const page = await signedIn(browser, fx.members.owner);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      for (const p of [path('/dashboard'), path('/projects/new'), path(`/projects/${main.id}`), path('/projects')]) {
        await page.goto(p);
        await expectNoSeriousA11yViolations(page, `${p} ${width} ${theme}`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${p} scrolls sideways`).toBe(true);
      }
    });
  }
}

test('NFR-SEC-11 FR-PRJ-01: hostile project text shows as text on S-08, S-10 and S-32', async ({ browser }) => {
  // A Viewer: Home (plan 1B Task 10) names every active project only in a Viewer's "Still open"; a person who records
  // sees one project's stages, which need not be this one. S-10 and S-32 read the same for every role.
  const page = await signedIn(browser, fx.members.viewer);
  failOnDialog(page);
  const name = HOSTILE_STRINGS[0];
  for (const p of [path('/dashboard'), path(`/projects/${hostileProject.id}`), path('/projects')]) {
    await page.goto(p);
    // Every place the name appears, shown or not (on S-10 the rail's project block, the page itself, and the narrow top
    // bar's copy, hidden from 1024 px), holds it as text: the element's own text is the literal markup, and no element
    // was parsed out of it. At least one occurrence is visible.
    const occurrences = page.getByText(name, { exact: true });
    const count = await occurrences.count();
    expect(count, `${p}: the name appears`).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const node = occurrences.nth(i);
      expect(await node.evaluate((el) => el.textContent), `${p} #${i}`).toBe(name);
      expect(await node.evaluate((el) => el.querySelector('script, img') === null), `${p} #${i}: no element inside`).toBe(true);
    }
    await expect(occurrences.filter({ visible: true }).first()).toBeVisible();
    expect(await page.evaluate(() => [...document.querySelectorAll('script')].some((s) => (s.textContent ?? '').trim() === 'alert(1)')),
      `${p}: no script element made from the name`).toBe(false);
  }
  // S-10 at 1280 px: the top bar's copy of the name is in the markup but not shown, and not in the accessibility tree.
  await page.goto(path(`/projects/${hostileProject.id}`));
  const barCopy = page.locator('.shell-bar-project__name');
  await expect(barCopy).toHaveText(name);
  await expect(barCopy).toBeHidden();
  // display: none on the bar takes it and everything in it out of the accessibility tree.
  expect(await barCopy.evaluate((el) => getComputedStyle(el.closest('.shell-topbar')!).display)).toBe('none');
});

const SENTINELS: Record<Stage, number> = { 'pre-processing': 41, 'in-processing': 28, 'post-processing': 13 };   // in-processing gets one more below, with the mitigation   // open findings per stage after the extra in-processing finding below (28 + 1 = 29); the sum, 83, must appear nowhere
test('FR-RM-04 UX-06 UX-07: each stage count on S-10 and S-08 is a whole number in text, none is a percentage or a total, and the labels are neutral', async ({ browser }) => {
  test.setTimeout(120_000);
  const sentinels = { 'pre-processing': [41], 'in-processing': [29], 'post-processing': [13] };
  const sum = Object.values(sentinels).reduce((n, [count]) => n + count, 0);
  // Fixture text with no digits: Home (plan 1B Task 10) lists an Owner's findings with no mitigation by title, and the
  // default titles ("Fixture title 83") would put the sum on the page as the team's own words, not as a count.
  const sentinelOrg = await buildOrg({ label: 'prjsent', text: (field) => `Sentinel ${field}` });
  // The organisation's name carries buildOrg's random run id, whose digits can be the sum (about one id in 150 holds a whole
  // "83"), and S-10 prints the project's name in its heading and breadcrumb ("Projects › name", Route R5). Both are the
  // test's own text, so the check is told to leave them out (`ownText`). Here the project's name always holds the sum, so a
  // run that stops leaving it out fails every time.
  const orgName = `${sentinelOrg.org.name} (${sum})`;
  await testDb.organization.update({ where: { id: sentinelOrg.org.id }, data: { name: orgName } });
  const projectName = `Sentinel counts (${sum})`;
  const own = { ownText: [orgName, sentinelOrg.org.slug, projectName] };
  const project = await addProject(sentinelOrg, { name: projectName });
  for (const [stage, n] of Object.entries(SENTINELS)) {
    for (let i = 0; i < n; i += 1) await addFinding(sentinelOrg, project.id, { stage: stage as Stage, source: 'team' });
  }
  // One accepted risk (a closed finding, so the open counts stay as set) gives S-10 something recorded, hence status labels to check.
  await addAcceptedRisk(sentinelOrg, (await addFinding(sentinelOrg, project.id, { stage: 'pre-processing', source: 'team' })).id, {});
  // The owner owns one mitigation that is not yet due, so S-08 has a status label to check.
  await addMitigationVersion(sentinelOrg, (await addFinding(sentinelOrg, project.id, { stage: 'in-processing', source: 'team' })).id, { status: 'planned', owner: 'owner', dueDate: '2099-01-01' });
  const page = await signedIn(browser, sentinelOrg.members.owner);
  const s10 = `/orgs/${sentinelOrg.org.slug}/projects/${project.id}`;
  for (const p of [s10, `/orgs/${sentinelOrg.org.slug}/dashboard`]) {
    await page.goto(p);
    if (p === s10) await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(projectName);
    await expectCountsAsWholeNumbersPerStage(page, sentinels, own);
    await expectStatusMarksInk(page);
  }
  // Only the name is left out: the three counts added up and written into S-10 beside it are still found. Hydration can
  // land after load and drop an element React did not render, so the element is written again until the check has read it.
  await page.goto(s10);
  await expect(async () => {
    await page.locator('main').first().evaluate((main, n) => {
      if (main.querySelector('#planted-total')) return;
      const p = document.createElement('p');
      p.id = 'planted-total';
      p.textContent = `${n} open findings`;
      main.append(p);
    }, sum);
    await expect(expectCountsAsWholeNumbersPerStage(page, sentinels, own)).rejects.toThrow(new RegExp(`the sum ${sum} of three stages' counts appears: "[^"]*${sum} open findings"`));
  }).toPass({ timeout: 10_000 });
});
