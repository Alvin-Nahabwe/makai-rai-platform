import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { newProject, openQuestion } from './helpers/session';
import { QUESTION_COPY } from '../lib/question/copy';

/**
 * The question page's frame (plan 1C decision C1, cut to slice 1): the question in words is the h1, the form follows it
 * in the main column, and the guidance is an aside, beside the form on a wide window and after it on a narrow one.
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
/** The first option of the status choice, the form's first field. */
const firstStatus = (page: Page) => page.locator('label[for="decision-status-done"]');

/** The status choice is wholly in the first view: nothing has scrolled, and its first option ends above the fold. */
async function expectStatusInFirstView(page: Page, height: number, what: string): Promise<void> {
  const scrolled = await page.evaluate(() => window.scrollY + (document.querySelector('.shell__main')?.scrollTop ?? 0));
  expect(scrolled, `${what}: the page has not scrolled`).toBe(0);
  const b = await box(firstStatus(page));
  expect(b.y + b.height, `${what}: the status choice ends at ${b.y + b.height}px of ${height}`).toBeLessThanOrEqual(height);
}

test('at 1280 by 900 the guidance aside is to the right of the form, and the status choice is in the first view for a question with no decision', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openQuestion(page, 'assessor', Q, baseURL!);
  await expect(heading(page), 'Q-PP-01 is the fixture bundle\'s longest question').toHaveText(LONGEST_FIXTURE);
  const f = await box(form(page));
  const a = await box(aside(page));
  expect(a.x, 'the aside starts right of the form').toBeGreaterThanOrEqual(f.x + f.width);
  expect(a.y, 'the aside starts beside the form, not below it').toBeLessThan(f.y + f.height);
  await expectStatusInFirstView(page, 900, Q);
  // The longest question of the running real bundle, in the same place.
  expect(LONGEST_REAL.length).toBeGreaterThan(0);
  await heading(page).evaluate((h, text) => { h.textContent = text; }, LONGEST_REAL);
  await expectStatusInFirstView(page, 900, `the longest real question (${LONGEST_REAL.length} characters)`);
});

test('the two columns start at 72.5rem: at 1160 the main column keeps 30rem beside a 16rem guide, at 1150 the page is one column', async ({ page, baseURL }) => {
  const projectId = await newProject(baseURL!);
  await page.setViewportSize({ width: 1160, height: 900 });
  await openQuestion(page, 'assessor', Q, baseURL!, projectId);
  const main = await box(page.locator('.question-workspace__main'));
  const guide = await box(page.locator('.question-workspace__guide'));
  expect(main.width, 'the main column').toBeGreaterThanOrEqual(480);
  expect(guide.width, 'the guide column').toBeGreaterThanOrEqual(256);
  expect(guide.x).toBeGreaterThanOrEqual(main.x + main.width);
  await expect(page.locator('.question-content__jump')).toBeHidden();
  await page.setViewportSize({ width: 1150, height: 900 });
  const main2 = await box(page.locator('.question-workspace__main'));
  const guide2 = await box(page.locator('.question-workspace__guide'));
  expect(guide2.y, 'the guide follows the main column').toBeGreaterThanOrEqual(main2.y + main2.height);
  await expect(page.locator('.question-content__jump')).toBeVisible();
});

test('at 375 by 812 the page is one column in reading order: heading, current decision, form, guidance, finding link; nothing scrolls sideways; the end of the page clears the fixed save bar', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openQuestion(page, 'assessor', Q, baseURL!);
  const order = [
    heading(page), page.locator('section[data-region="current-decision"]'), form(page), aside(page), page.locator('section[data-region="finding-link"]'),
  ];
  const boxes = await Promise.all(order.map(box));
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i].y, `region ${i} is below region ${i - 1}`).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].height);
  }
  const follows = await page.evaluate(() => {
    const els = ['#question-heading', 'section[data-region="current-decision"]', 'section[data-region="answer-form"]', 'aside[data-region="guidance"]', 'section[data-region="finding-link"]']
      .map((s) => document.querySelector(s)!);
    return els.slice(1).map((el, i) => (els[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  });
  expect(follows).toEqual([true, true, true, true]);
  await expectNoHorizontalScroll(page);
  // The page's last content (the suggestions here; Q-PP-01 has some) scrolls clear of the bar fixed to the bottom.
  const bar = page.locator('.decision-save-bar');
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  const last = await box(page.locator('section[data-region="suggestions"]'));
  const b = await box(bar);
  expect(last.y + last.height, 'the end of the suggestions is above the save bar').toBeLessThanOrEqual(b.y);
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
  await expect(page.getByRole('link', { name: QUESTION_COPY.nav.allQuestions, exact: true })).toBeVisible();
  const answer = form(page);
  await expect(answer.locator('[data-permission-note]')).toBeVisible();
  await expect(answer.locator('input, select, textarea, button')).toHaveCount(0);
  const f = await box(answer);
  const a = await box(aside(page));
  expect(a.x).toBeGreaterThanOrEqual(f.x + f.width);
});
