import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { HOSTILE_STRINGS } from '../__tests__/helpers/hostile';
import {
  addAcceptedRisk, addFinding, addMitigationVersion, addProject, buildOrg, type FixtureAccount, type OrgFixture,
} from '../__tests__/helpers/recordFixture';
import { testDb } from '../__tests__/helpers/db';
import type { Stage } from '../types/record';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { expectCountsAsWholeNumbersPerStage, expectStatusMarksInk } from './helpers/noScore';
import { PROJECT_COPY } from '../lib/project/copy';

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
  await expect(page.getByRole('listitem').filter({ hasText: /\d+ with no decision/ }).first()).toBeVisible();   // the collapsed-heading copy of the count is hidden while the stage is open
});

test('UX-06: to-do counts come before recorded counts; status is words in ink, with no tick and no green (S-10 and S-08)', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path(`/projects/${main.id}`));
  const text = await page.locator('[data-stage="pre-processing"]').innerText();
  expect(text.indexOf('with no decision')).toBeLessThan(text.indexOf('Recorded'));
  for (const p of [path(`/projects/${main.id}`), path('/dashboard')]) {
    await page.goto(p);
    await expectStatusMarksInk(page);
  }
});

test('NFR-A11Y-02 FR-PRJ-03: keyboard only, an owner opens S-10, archives with the inline confirmation, and sees the banner', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path('/dashboard'));
  await tabUntil(page, new RegExp(KEYBOARD_NAME));
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
  await expect(page.getByRole('status').filter({ hasText: 'Not archived: connection lost.' })).toBeVisible();
  await page.unroute('**/archive');
  await page.route('**/archive', async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue(); });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Archiving...')).toBeVisible();
  await expect(page.getByText('Archived. Nothing in this project can be changed until it is unarchived.')).toBeVisible();
  await expect(page.getByText(PROJECT_COPY.archivedBanner)).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(ids[0]).toMatch(UUID_V4);
  expect(ids[1]).toBe(ids[0]);
});

test('UX-27 NFR-INT-02: S-09 keeps its request id when the same form is sent again after a lost connection, and takes a new one once a field is edited', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto(path('/projects/new'));
  const ids = requestIdsOf(page, /\/api\/v1\/orgs\/[^/]+\/projects$/);
  let posts = 0;
  await page.route('**/api/v1/orgs/*/projects', (r) => (r.request().method() === 'POST' && posts++ < 2 ? r.abort('internetdisconnected') : r.continue()));
  await page.getByLabel('Project name').fill('Retry probe');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByText('Something went wrong. Please try again.')).toBeVisible();
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByText('Something went wrong. Please try again.')).toBeVisible();
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
  const SLOW = 'Still saving. The connection is slow.';
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
  await expect(owner.getByRole('status').filter({ hasText: SLOW })).toBeVisible({ timeout: 20_000 });
  await expect(owner.getByText('Archived. Nothing in this project can be changed until it is unarchived.')).toBeVisible({ timeout: 20_000 });

  await owner.goto(path('/projects'));
  await owner.route('**/unarchive', hold);
  await owner.getByRole('button', { name: `Unarchive ${`PRJ slow unarchive ${RUN}`}` }).click();
  await expect(owner.getByRole('status').filter({ hasText: SLOW })).toBeVisible({ timeout: 20_000 });
  await expect(owner.getByRole('button', { name: `Unarchive ${`PRJ slow unarchive ${RUN}`}` })).toHaveCount(0, { timeout: 20_000 });
  void shelvedSlow;
});

test('SPEC-2 F8: a 422 on a field in the closed details opens them and shows the message beside the field and in the summary; a 403 on Archive keeps its line and disables the button', async ({ browser }) => {
  const owner = await signedIn(browser, fx.members.owner);
  await owner.goto(path('/projects/new'));
  await owner.getByLabel('Project name').fill(`Too long sector ${RUN}`);
  await owner.getByRole('button', { name: 'Show additional details' }).click();
  await owner.getByLabel('Sector').fill('s'.repeat(201));
  await owner.getByRole('button', { name: 'Show additional details' }).click();   // close the section again
  await owner.getByRole('button', { name: 'Create project' }).click();
  await expect(owner.getByRole('alert').filter({ hasText: 'There is a problem with this project. What you typed is kept.' })).toBeVisible();
  await expect(owner.getByLabel('Sector')).toBeVisible();   // the section was opened for the person
  await expect(owner.locator('#deploymentSector-error')).toContainText('at most 200 characters');
  await expect(owner.getByLabel('Sector')).toHaveAttribute('aria-describedby', 'deploymentSector-error');

  await owner.goto(path(`/projects/${emptyProject.id}`));
  await owner.route('**/archive', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Forbidden', code: 'forbidden' }) }));
  await owner.getByRole('button', { name: 'Archive project' }).click();
  await owner.getByRole('button', { name: 'Archive project' }).last().click();
  await expect(owner.getByRole('status').filter({ hasText: 'You can no longer change this project.' })).toBeVisible();
  await expect(owner.getByRole('button', { name: 'Archive project' })).toBeDisabled();
});

test('FR-PRJ-01: an assessor creates a project with every descriptive field and edits one; S-10 shows both', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto(path('/projects/new'));
  await page.getByLabel('Project name').fill(`Described ${RUN}`);
  await page.getByLabel('AI system type').selectOption('classification');
  await page.getByRole('button', { name: 'Show additional details' }).click();
  await page.getByLabel('Sector').fill('health');
  await page.getByLabel('Dataset type').fill('tabular');
  await page.getByLabel('Dataset size').selectOption('medium_1k_100k');
  await page.getByLabel('Personal data').selectOption('true');
  await page.getByLabel('Funding source').fill('GIZ');
  await page.getByLabel('Regulatory context').fill('A national data-protection act');
  await page.getByLabel('Lifecycle stage').selectOption('development');
  await page.getByLabel('Start date').fill('2026-09-01');
  await page.getByLabel('End date').fill('2027-03-31');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Classification, health, personal data: yes, lifecycle stage: Development')).toBeVisible();
  await page.getByRole('link', { name: 'Edit project' }).click();
  await page.getByLabel('Lifecycle stage').selectOption('testing');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Classification, health, personal data: yes, lifecycle stage: Testing')).toBeVisible();
});

test('UX-27 NFR-INT-02: S-32 sends Unarchive with a request id and keeps it across a Retry', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(path('/projects'));
  const before = await page.getByRole('button', { name: 'Unarchive' }).count();
  const ids = requestIdsOf(page, /\/unarchive$/);
  let sends = 0;
  await page.route('**/unarchive', (r) => (sends++ < 1 ? r.abort('internetdisconnected') : r.continue()));
  await page.getByRole('button', { name: 'Unarchive' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: 'Not unarchived: connection lost.' })).toBeVisible();
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
  await expect(page.getByText('Nothing recorded yet.')).toHaveCount(3);
  await expect(page.getByText(PROJECT_COPY.followUp.none)).toHaveCount(3);
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
  const page = await signedIn(browser, fx.members.owner);
  failOnDialog(page);
  for (const p of [path('/dashboard'), path(`/projects/${hostileProject.id}`), path('/projects')]) {
    await page.goto(p);
    await expect(page.getByText(HOSTILE_STRINGS[0]).first()).toBeVisible();
  }
});

const SENTINELS: Record<Stage, number> = { 'pre-processing': 41, 'in-processing': 28, 'post-processing': 13 };   // in-processing gets one more below, with the mitigation   // open findings per stage after the extra in-processing finding below (28 + 1 = 29); the sum, 83, must appear nowhere
test('FR-RM-04 UX-06 UX-07: each stage count on S-10 and S-08 is a whole number in text, none is a percentage or a total, and the labels are neutral', async ({ browser }) => {
  test.setTimeout(120_000);
  const sentinels = { 'pre-processing': [41], 'in-processing': [29], 'post-processing': [13] };
  const sum = Object.values(sentinels).reduce((n, [count]) => n + count, 0);
  const sentinelOrg = await buildOrg({ label: 'prjsent' });
  // S-10 prints the organisation's name in its breadcrumb, and the name carries buildOrg's random run id, whose digits
  // can be the sum (about one id in 150 holds a whole "83"). The name is the test's own text, so the check is told to
  // leave it out (`ownText`). Here the name always holds the sum, so a run that stops leaving it out fails every time.
  const orgName = `${sentinelOrg.org.name} (${sum})`;
  await testDb.organization.update({ where: { id: sentinelOrg.org.id }, data: { name: orgName } });
  const own = { ownText: [orgName, sentinelOrg.org.slug] };
  const project = await addProject(sentinelOrg, { name: 'Sentinel counts' });
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
    if (p === s10) await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(orgName);
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
