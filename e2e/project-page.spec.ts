import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  addFinding, addMitigationVersion, addProject, addSealRow, addStageReview, buildOrg, type FixtureAccount, type OrgFixture,
} from '../__tests__/helpers/recordFixture';
import { STAGES } from '../types/record';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { expectNoScoreShapes, expectStatusMarksInk } from './helpers/noScore';
import { PROJECT_COPY } from '../lib/project/copy';
import { PROJECT_WRITE_COPY } from '../lib/project/write/copy';
import { UI_COPY } from '../lib/ui/copy';

/**
 * S-10 as three lines of stops in a browser (lane 4 Task A; Route R5; spec 9.2; plan 1C Task 8): side by side at 1280 px
 * with each line's stops on the same rows, stacked in stage order at 375 px, reflowing at 320 px with a 70-character name
 * and an unbroken mitigation string, every heading delivered with JavaScript off, archiving by keyboard with the inline
 * confirmation from the "This project" row, no score shapes, status marks in ink, and no serious axe violation in either
 * theme. The organisation is this spec's own (the record fixture builder); each case signs in on the login page.
 */
const RUN = randomUUID().slice(0, 8);
const LONG_NAME = `Antenatal risk triage for adolescent clinics ${RUN} `.padEnd(70, 'x');
const UNBROKEN = `https://example.org/${'a'.repeat(160)}`;

let fx: OrgFixture;
let project: { id: string };
let archiveMe: { id: string };
const contexts: BrowserContext[] = [];
let ipSeq = 0;
const nextClientIp = () => `10.83.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

async function signedIn(browser: Browser, account: Pick<FixtureAccount, 'email' | 'password'>, js = true): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': nextClientIp() } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto('/login');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
  if (js) return page;
  const off = await browser.newContext({ javaScriptEnabled: false, storageState: await context.storageState() });
  contexts.push(off);
  return off.newPage();
}

const projectPath = (id: string) => `/orgs/${fx.org.slug}/projects/${id}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  fx = await buildOrg({ label: 'lines', text: (field, seq) => (field === 'what' ? UNBROKEN : `Lines ${field} ${seq}`) });
  project = await addProject(fx, { name: LONG_NAME });
  archiveMe = await addProject(fx, { name: `Lines archive ${RUN}` });
  // An open finding with an overdue mitigation in pre-processing; one sealed and one unsealed review there.
  const finding = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team' });
  await addMitigationVersion(fx, finding.id, { status: 'in_progress', owner: 'assessor', dueDate: '2020-01-01' });
  const sealed = await addStageReview(fx, project.id, { stage: 'pre-processing', preparedFor: 'Ethics committee' });
  await addSealRow(fx, sealed.id);
  await addStageReview(fx, project.id, { stage: 'pre-processing' });
  // One decision in each stage, through the route with the owner's own session.
  const owner = await signedIn(browser, fx.members.owner);
  for (const [stage, questionId] of [['pre-processing', 'Q-PP-01'], ['in-processing', 'Q-IP-01'], ['post-processing', 'Q-PO-01']]) {
    const res = await owner.context().request.post(`/api/v1/orgs/${fx.org.slug}/projects/${project.id}/decisions`, {
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

/** The top of each line's stop of this kind, in stage order. */
const topsOf = (page: Page, stop: string) => Promise.all(STAGES.map(async (s) => (await page.locator(`#${s} .stage-line__stop--${stop}`).boundingBox())?.y ?? NaN));

test('R5 at 1280 px: the three lines side by side, each stop on the same row across the lines; the primary on one line only', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(projectPath(project.id));
  const boxes = await Promise.all(STAGES.map(async (s) => page.locator(`#${s}`).boundingBox()));
  expect(boxes.every((b) => b !== null)).toBe(true);
  expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);
  expect(boxes[1]!.x).toBeLessThan(boxes[2]!.x);
  for (const stop of ['open', 'recorded', 'reviews', 'last']) {
    const tops = await topsOf(page, stop);
    // Pre-processing's Still open holds an overdue plate the other lines do not, and still the next stops share their rows.
    expect(Math.max(...tops) - Math.min(...tops), `${stop}: ${tops.join(', ')}`).toBeLessThanOrEqual(1);
  }
  await expect(page.locator('.stage-list__jump')).toBeHidden();
  await expectNoHorizontalScroll(page);
});

/** The page's one primary action, by role: what assistive technology and a person can reach. */
const PRIMARY = new RegExp(`^(${PROJECT_COPY.continue}|${PROJECT_COPY.start})$`);

for (const [width, height] of [[1280, 800], [1440, 900], [375, 812]] as const) {
  test(`C3 (owner's ruling): at ${width} px exactly one primary action is in the accessibility tree, inside the first view, with the next question`, async ({ browser }) => {
    const page = await signedIn(browser, fx.members.owner);
    await page.setViewportSize({ width, height });
    await page.goto(projectPath(project.id));
    const primary = page.getByRole('link', { name: PRIMARY });
    await expect(primary).toHaveCount(1);
    await expect(primary).toBeVisible();
    // Side by side it sits in the target line's head stop; stacked, in the block above the lines.
    await expect(primary.locator(width >= 1280 ? 'xpath=ancestor::div[contains(@class,"stage-line__stop--head")]' : 'xpath=ancestor::div[contains(@class,"next-step-block--stacked")]')).toHaveCount(1);
    const box = await primary.boundingBox();
    expect(box!.y + box!.height, `the button's foot (${Math.round(box!.y + box!.height)} px) is inside the ${height} px first view`).toBeLessThanOrEqual(height);
    await expect(page.getByText(PROJECT_COPY.nextLabel, { exact: true }).filter({ visible: true })).toHaveCount(1);
  });
}

test('R5 at 375 px: the lines stack in stage order, the jump links show, Archive is still last in the wrapped row', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(projectPath(project.id));
  const ys = await Promise.all(STAGES.map(async (s) => (await page.locator(`#${s}`).boundingBox())?.y ?? NaN));
  expect(ys[0]).toBeLessThan(ys[1]);
  expect(ys[1]).toBeLessThan(ys[2]);
  await expect(page.locator('.stage-list__jump')).toBeVisible();
  const row = page.locator('nav.project-actions');
  const archive = await row.getByRole('button', { name: PROJECT_WRITE_COPY.archive.trigger }).boundingBox();
  const edit = await row.getByRole('link', { name: PROJECT_COPY.editProjectDetails }).boundingBox();
  expect(archive!.y + archive!.height).toBeGreaterThan(edit!.y);   // after Edit: on its line or below it
  await expectNoHorizontalScroll(page);
});

test('Review Focus 4: at 320 px a 70-character name and an unbroken mitigation string wrap; no horizontal scroll', async ({ browser }) => {
  expect(LONG_NAME).toHaveLength(70);
  const page = await signedIn(browser, fx.members.owner);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(projectPath(project.id));
  await expect(page.getByRole('heading', { level: 1, name: LONG_NAME })).toBeVisible();
  await expect(page.getByRole('link', { name: UNBROKEN })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('UX-36: with JavaScript off the page delivers every heading: the name, the three stages, each stop\'s heading and "This project"', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner, false);
  await page.goto(projectPath(project.id));
  await expect(page.getByRole('heading', { level: 1, name: LONG_NAME })).toBeVisible();
  for (const name of Object.values(PROJECT_COPY.stageNames)) await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  for (const name of [PROJECT_COPY.stage.stillOpen, PROJECT_COPY.stage.recorded, PROJECT_COPY.reviewsHeading]) {
    await expect(page.getByRole('heading', { level: 3, name, exact: true })).toHaveCount(3);
  }
  await expect(page.getByRole('heading', { level: 2, name: PROJECT_COPY.thisProject })).toBeVisible();
});

test('NFR-A11Y-02 FR-PRJ-03: by keyboard from the last line, Archive in the "This project" row opens its inline confirmation and archives; focus stays in the control', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(projectPath(archiveMe.id));
  await page.locator('#post-processing').getByRole('link', { name: PROJECT_COPY.stage.allQuestions }).focus();
  const archive = page.getByRole('button', { name: PROJECT_WRITE_COPY.archive.trigger });
  for (let i = 0; i < 6 && !(await archive.evaluate((el) => el === document.activeElement)); i += 1) await page.keyboard.press('Tab');
  await expect(archive).toBeFocused();
  await expectFocusVisibleAndUncovered(page);
  await page.keyboard.press('Enter');
  const confirmation = page.getByRole('group', { name: PROJECT_WRITE_COPY.archive.objectName(`Lines archive ${RUN}`) });
  await expect(confirmation.getByRole('button', { name: UI_COPY.confirm.cancel })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByText(PROJECT_COPY.archivedBanner)).toBeVisible();
  await expect(page.locator('.archive-control')).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: PROJECT_WRITE_COPY.archive.archived })).toBeVisible();
  await expect(page.locator('main .ui-button--primary')).toHaveCount(0);
});

test('FR-RM-01 spec 7.2: no score shapes, and every status mark and label in ink', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(projectPath(project.id));
  await expectNoScoreShapes(page, 'S-10 lines');
  await expectStatusMarksInk(page);
});

for (const theme of ['light', 'dark'] as const) {
  test(`NFR-A11Y-05: no serious axe violation at 1280 and 375 px, ${theme}`, async ({ browser }) => {
    const page = await signedIn(browser, fx.members.owner);
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(projectPath(project.id));
      await expectNoSeriousA11yViolations(page, `S-10 lines ${width} ${theme}`);
    }
  });
}
