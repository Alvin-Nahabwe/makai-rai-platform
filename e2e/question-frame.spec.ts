import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { fillValid, fixtureOrgSlug, newProject, openQuestion, saveStatus, saveViaApi, seatRequest } from './helpers/session';
import { QUESTION_COPY } from '../lib/question/copy';
import { UI_COPY } from '../lib/ui/copy';

/**
 * The question page's frame (lane 1 Task 1, the Route sketch): the question in words is the h1, the decision follows it
 * in the main column, and the guidance is an aside, below the decision from 72.5rem with the stage's questions as a column
 * on the left, beside it from 90rem, and after it on a narrow one (owner's decision "Route column", 14 November 2026). From
 * 72.5rem the top strip (breadcrumb and tally) runs across; under it the position strip. e2e/question-frame-route.spec.ts
 * holds the strips, the 1280 by 800 gate, the focus ring and the frame's states.
 * Every project is new, so no question has a decision. Q-PP-01 has the longest text of the fixture bundle the server
 * runs on; the longest text of the real bundles (data/content) is put into the h1 in place to measure it too.
 */
const Q = 'Q-PP-01';

type Bank = unknown;
/** Every question text of a question bank, whatever its nesting. */
function textsOf(bank: Bank): string[] {
  const out: string[] = [];
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o === null || typeof o !== 'object') return;
    const r = o as Record<string, unknown>;
    if (typeof r.id === 'string' && r.id.startsWith('Q-') && typeof r.text === 'string') out.push(r.text);
    Object.values(r).forEach(walk);
  };
  walk(bank);
  return out;
}
const readJson = (path: string): Bank => JSON.parse(readFileSync(path, 'utf8')) as Bank;
const LONGEST_FIXTURE = textsOf(readJson('__tests__/fixtures/content/0.0.1-fixture/questionBank.json')).sort((a, b) => b.length - a.length)[0];
const RUNNING = (readJson('data/content/index.json') as { running: string }).running;
const LONGEST_REAL = textsOf(readJson(`data/content/${RUNNING}/questionBank.json`)).sort((a, b) => b.length - a.length)[0];

test.beforeEach(async ({ page }) => { failOnDialog(page); });

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  expect(b, `${l} has a box`).not.toBeNull();
  return b!;
};
const heading = (page: Page) => page.locator('#question-heading');
const form = (page: Page) => page.locator('section[data-region="answer-form"]');
const aside = (page: Page) => page.locator('aside[data-region="guidance"]');
/** The last option's card of the status choice, the form's first field: the four cards are stacked, so the choice ends where this card ends. */
const lastStatus = (page: Page) => page.locator('.ui-radio-card:has(#decision-status-not_applicable)');

/** The status choice is wholly in the first view: nothing has scrolled, and its last option's card ends above the fold. */
async function expectStatusInFirstView(page: Page, height: number, what: string): Promise<void> {
  const scrolled = await page.evaluate(() => window.scrollY + (document.querySelector('.shell__main')?.scrollTop ?? 0));
  expect(scrolled, `${what}: the page has not scrolled`).toBe(0);
  const b = await box(lastStatus(page));
  expect(b.y + b.height, `${what}: the status choice ends at ${b.y + b.height}px of ${height}`).toBeLessThanOrEqual(height);
}

const routeCol = (page: Page) => page.locator('.question-workspace__route');

test('at 1280 by 900 the stage\'s questions are the column left of the form, the guidance aside is below the form, and the status choice is in the first view for a question with no decision', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openQuestion(page, 'assessor', Q, baseURL!);
  await expect(heading(page), 'Q-PP-01 is the fixture bundle\'s longest question').toHaveText(LONGEST_FIXTURE);
  const f = await box(form(page));
  const a = await box(aside(page));
  const r = await box(routeCol(page));
  expect(f.x, 'the form starts right of the stage\'s column').toBeGreaterThanOrEqual(r.x + r.width);
  expect(r.y, 'the column starts beside the form, not below it').toBeLessThan(f.y + f.height);
  expect(a.y, 'the aside starts below the form').toBeGreaterThanOrEqual(f.y + f.height);
  await expectStatusInFirstView(page, 900, Q);
  // The longest question of the running real bundle, in the same place.
  expect(LONGEST_REAL.length).toBeGreaterThan(0);
  await heading(page).evaluate((h, text) => { h.textContent = text; }, LONGEST_REAL);
  await expectStatusInFirstView(page, 900, `the longest real question (${LONGEST_REAL.length} characters)`);
});

test('the column starts at 72.5rem: at 1160 the main column keeps 30rem beside a 16rem column, at 1150 the page is one column; three columns from 90rem: at 1440 the main one keeps 30rem, at 1430 two', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  await page.setViewportSize({ width: 1160, height: 900 });
  await openQuestion(page, 'assessor', Q, baseURL!, projectId);
  const main = await box(page.locator('.question-workspace__main'));
  const route = await box(routeCol(page));
  const guide = await box(page.locator('.question-workspace__guide'));
  expect(main.width, 'the main column').toBeGreaterThanOrEqual(480);
  expect(route.width, 'the stage\'s column').toBeGreaterThanOrEqual(256);
  expect(main.x).toBeGreaterThanOrEqual(route.x + route.width);
  expect(guide.y, 'the guide is below the main column').toBeGreaterThanOrEqual(main.y + main.height);
  await expect(page.locator('.question-top'), 'the top strip runs across from 1160').toBeVisible();
  await expect(page.locator('.position-strip')).toBeHidden();
  await page.setViewportSize({ width: 1150, height: 900 });
  const main2 = await box(page.locator('.question-workspace__main'));
  const guide2 = await box(page.locator('.question-workspace__guide'));
  const route2 = await box(routeCol(page));
  expect(guide2.y, 'the guide follows the main column').toBeGreaterThanOrEqual(main2.y + main2.height);
  expect(route2.y, 'the stage\'s short form follows the guide').toBeGreaterThanOrEqual(guide2.y + guide2.height);
  await expect(page.locator('.question-top')).toBeHidden();
  await expect(page.locator('.position-strip'), 'under 1160 the position strip does the top strip\'s job').toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  const main3 = await box(page.locator('.question-workspace__main'));
  const route3 = await box(routeCol(page));
  const guide3 = await box(page.locator('.question-workspace__guide'));
  expect(main3.width, 'the main column at 1440').toBeGreaterThanOrEqual(480);
  expect(route3.width).toBeGreaterThanOrEqual(256);
  // The sketch's 240px guidance column from 1440 (design fix S1a-2).
  expect(guide3.width).toBeGreaterThanOrEqual(232);
  expect(main3.x).toBeGreaterThanOrEqual(route3.x + route3.width);
  expect(guide3.x).toBeGreaterThanOrEqual(main3.x + main3.width);
  // The ways teams address this are one folded control at every width (spec 9.3): closed until pressed.
  await expect(page.locator('details.question-content__ways')).not.toHaveAttribute('open', /.*/);
  await page.setViewportSize({ width: 1430, height: 900 });
  const main4 = await box(page.locator('.question-workspace__main'));
  const guide4 = await box(page.locator('.question-workspace__guide'));
  expect(guide4.y, 'at 1430 the guide is below the main column').toBeGreaterThanOrEqual(main4.y + main4.height);
});

test('at 375 by 812 the page is one column in reading order: heading, current decision, form, finding link (in the decision), guidance; nothing scrolls sideways; the end of the page clears the fixed save bar', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openQuestion(page, 'assessor', Q, baseURL!);
  const order = [
    heading(page), page.locator('section[data-region="current-decision"]'), form(page), page.locator('section[data-region="finding-link"]'), aside(page),
  ];
  const boxes = await Promise.all(order.map(box));
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i].y, `region ${i} is below region ${i - 1}`).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].height);
  }
  const follows = await page.evaluate(() => {
    const els = ['#question-heading', 'section[data-region="current-decision"]', 'section[data-region="answer-form"]', 'section[data-region="finding-link"]', 'aside[data-region="guidance"]']
      .map((s) => document.querySelector(s)!);
    return els.slice(1).map((el, i) => (els[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  });
  expect(follows).toEqual([true, true, true, true]);
  await expectNoHorizontalScroll(page);
  // The page's last content (the route column, last in reading order) scrolls clear of the bar fixed to the bottom.
  const bar = page.locator('.decision-save-bar');
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  const last = await box(routeCol(page));
  const b = await box(bar);
  expect(last.y + last.height, 'the end of the route column is above the save bar').toBeLessThanOrEqual(b.y);
});

test('at 320 by 640 nothing scrolls sideways', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openQuestion(page, 'assessor', Q, baseURL!);
  await expectNoHorizontalScroll(page);
  // and with the longest real question in the heading
  await heading(page).evaluate((h, text) => { h.textContent = text; }, LONGEST_REAL);
  await expectNoHorizontalScroll(page);
});

test('no serious accessibility violation at 1280 and at 375', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  for (const [width, height] of [[1280, 900], [375, 812]] as const) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme });
      await openQuestion(page, 'assessor', Q, baseURL!, projectId);
      await expectNoSeriousA11yViolations(page, `question page, ${width}, ${colorScheme}`);
    }
  }
});

test('a Viewer sees the same frame with no form controls', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openQuestion(page, 'viewer', Q, baseURL!);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(LONGEST_FIXTURE);
  await expect(page.locator('#question-heading + .question-frame__code')).toHaveText(/^Q-PP-01 · /);
  await expect(page.getByRole('complementary', { name: QUESTION_COPY.content.goodPractice })).toBeVisible();
  // From 1160 the breadcrumb leads back to the stage's questions (on narrow screens the top bar does).
  await expect(page.getByRole('navigation', { name: UI_COPY.breadcrumbLabel }).getByRole('link', { name: 'Pre-processing', exact: true })).toBeVisible();
  // The read-only view (plan 1C Task 7; lane 1 Task 3): no answer-form region; the one line sits in the reader's aside at the
  // top of the guidance column, and the main column holds no control.
  const main = page.locator('.question-workspace__main');
  await expect(form(page)).toHaveCount(0);
  await expect(page.locator('[data-region="reading-aside"] [data-permission-note]')).toBeVisible();
  await expect(main.locator('input, select, textarea, button')).toHaveCount(0);
  const f = await box(page.locator('section[data-region="current-decision"]'));
  const a = await box(aside(page));
  expect(a.y, 'the aside is below the form at 1280').toBeGreaterThanOrEqual(f.y + f.height);
});

/**
 * Plan 1C Task 7 (decision C12): a Reviewer and a Viewer read what the team decided and what is still open on the question.
 * An Assessor saves Q-PP-01 as Partly with a reason, so the platform raises a finding for it.
 */
for (const role of ['viewer', 'reviewer'] as const) {
  test(`C12: a ${role} reads What the team decided, the reason, and the one finding still open, with no form, at every width`, async ({ page, baseURL }) => {
    const reason = `Only a rules baseline was compared (${role}).`;
    const projectId = await newProject(baseURL!);
    expect((await saveViaApi(baseURL!, 'assessor', projectId, Q, { status: 'partly', reason })).status).toBe(201);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openQuestion(page, role, Q, baseURL!, projectId);
    await expect(page.getByRole('heading', { level: 2, name: QUESTION_COPY.reading.title })).toBeVisible();
    await expect(page.locator('blockquote.reading-decision__reason')).toHaveText(reason);
    const open = page.locator('section[data-region="open-work"]');
    await expect(open.getByRole('heading', { level: 2 })).toHaveText(QUESTION_COPY.reading.stillOpen(1));
    // No decision form; the route column's GET filter ("Show") is a form of its own and stays for every role.
    await expect(page.locator('form:not(.route-column__filter)')).toHaveCount(0);
    await expect(page.locator('[data-region="answer-form"]')).toHaveCount(0);
    await expect(page.locator('.decision-save-bar')).toHaveCount(0);
    // Coordinator's ruling on review S1a-4 and design fix S4-N2: a Reviewer's raise link sits in the main column after what
    // is still open (spec 9.3: open findings directly under the decision); none in the guidance column; a Viewer has none.
    const raise = page.getByRole('link', { name: QUESTION_COPY.findingLink.raise });
    await expect(raise).toHaveCount(role === 'reviewer' ? 1 : 0);
    await expect(page.locator('.question-workspace__guide [data-region="finding-link"]')).toHaveCount(0);
    if (role === 'reviewer') {
      const stillOpen = await box(open);
      const raised = await box(raise);
      expect(raised.y, 'the raise link comes after what is still open').toBeGreaterThanOrEqual(stillOpen.y + stillOpen.height);
    }
    // The open finding is listed once, in the main column, not again in the aside (review M2); what is still open closes the
    // column, and the way on is the reader's aside's one primary link (lane 1 Task 3, viewer-reading.png).
    await expect(page.getByRole('link', { name: QUESTION_COPY.findingLink.view })).toHaveCount(0);
    await expect(page.locator('.question-workspace__main > :last-child')).toHaveAttribute('data-region', role === 'reviewer' ? 'finding-link' : 'open-work');
    await expect(page.locator('[data-region="reading-aside"] .ui-button--primary')).toHaveCount(1);
    for (const [width, height] of [[1280, 900], [375, 812], [320, 640]] as const) {
      await page.setViewportSize({ width, height });
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page, `read-only question page, ${role}, ${width}`);
    }
    const link = open.getByRole('link');
    await expect(link).toHaveCount(1);
    const href = await link.getAttribute('href');
    expect(href).toMatch(new RegExp(`/projects/${projectId}/findings/[^/]+$`));
    const res = await page.goto(href!);
    expect(res!.status()).toBe(200);
  });
}

// ─── Workshop walk S3 and S9: the switched-off question says so, the position is true, and the foot gives a way on ──

const GATE = 'Q-PP-GATE-SENSITIVE';

/** The Assessor answers the personal data question No through route 1 (the gate takes a scope answer, no status). */
async function answerGateNo(baseURL: string, projectId: string): Promise<void> {
  const ctx = await seatRequest(baseURL, 'assessor');
  try {
    const res = await ctx.post(`/api/v1/orgs/${fixtureOrgSlug()}/projects/${projectId}/decisions`, { data: {
      requestId: crypto.randomUUID(), stage: 'pre-processing', questionId: GATE, baseVersionNumber: null,
      status: null, scopeAnswer: 'no', optionsInPlace: [], reasonCode: null, reason: 'The model uses no personal data.',
      decidedBy: { kind: 'outside_role', role: 'supervisor' }, declaredDate: '2026-10-12', evidenceIds: [],
    } });
    expect(res.status(), 'the gate answer is saved').toBe(201);
  } finally {
    await ctx.dispose();
  }
}
/** The position in the breadcrumb's current item (shown from 1160px; the position strip says the same under it). */
const stripPosition = (page: Page) => page.locator('.question-top .ui-breadcrumb__current');
const wayOn = (page: Page) => page.locator('[data-region="way-on"]');

test('S3: after the personal data answer is No, Q-PP-13 and Q-PP-14 say they do not apply, keep the form, and hold their own places of 24', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const projectId = await newProject(baseURL!);
  await answerGateNo(baseURL!, projectId);
  for (const [id, n] of [['Q-PP-13', 14], ['Q-PP-14', 15]] as const) {
    await openQuestion(page, 'assessor', id, baseURL!, projectId);
    const note = page.locator('#question-heading ~ [data-does-not-apply]');
    await expect(note, id).toHaveText(QUESTION_COPY.doesNotApply);
    await expect(page.getByRole('group', { name: 'Status' }), id).toBeVisible();
    await expect(stripPosition(page), id).toHaveText(`Question ${n} of 24`);
  }
  await openQuestion(page, 'assessor', 'Q-PP-12', baseURL!, projectId);
  await expect(page.locator('[data-does-not-apply]')).toHaveCount(0);
  await expect(stripPosition(page)).toHaveText('Question 12 of 24');
});

for (const [width, height] of [[1280, 900], [375, 812]] as const) {
  test(`S9: at ${width} by ${height}, after a save on the first question, the foot's Next question link is below the form, scrolls into view clear of the save bar, and opens the next question`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height });
    await openQuestion(page, 'assessor', Q, baseURL!);
    await fillValid(page);
    await page.getByRole('button', { name: 'Save decision', exact: true }).click();
    await expect(saveStatus(page)).toHaveText(/^Saved at /);
    const next = wayOn(page).getByRole('link', { name: /^Next question: / });
    await expect(next).toHaveCount(1);
    await expect(wayOn(page).getByRole('link', { name: QUESTION_COPY.nav.allQuestions, exact: true })).toBeVisible();
    const f = await box(form(page));
    const n = await box(next);
    expect(n.y, 'the link is below the form').toBeGreaterThanOrEqual(f.y + f.height);
    await next.evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'instant' }));
    const seen = await box(next);
    expect(seen.y, 'the link is on the screen').toBeGreaterThanOrEqual(0);
    expect(seen.height, 'the link is a target of at least 24px').toBeGreaterThanOrEqual(24);
    const bar = page.locator('.decision-save-bar');
    if (await bar.evaluate((el) => getComputedStyle(el).position) === 'fixed') {
      const b = await box(bar);
      expect(seen.y + seen.height, 'the link ends above the fixed save bar').toBeLessThanOrEqual(b.y);
    } else {
      expect(seen.y + seen.height, 'the link ends on the screen').toBeLessThanOrEqual(height);
    }
    await next.click();
    await expect(page.locator('#question-heading + .question-frame__code')).toHaveText(/^Q-PP-02 \u00b7 /);
  });
}

test('S3: Q-PP-13 after the No has no serious accessibility violation and nothing scrolls sideways at 1280, 375 and 320', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  await answerGateNo(baseURL!, projectId);
  for (const [width, height] of [[1280, 900], [375, 812], [320, 640]] as const) {
    await page.setViewportSize({ width, height });
    await openQuestion(page, 'assessor', 'Q-PP-13', baseURL!, projectId);
    await expect(page.locator('[data-does-not-apply]')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, `Q-PP-13 after No, ${width}`);
  }
});
