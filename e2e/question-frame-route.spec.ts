import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { failOnDialog } from './helpers/dialogs';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { fixtureOrgSlug, newProject, openQuestion, saveViaApi, seatRequest } from './helpers/session';
import { QUESTION_COPY } from '../lib/question/copy';

/**
 * The question page's frame to the Route sketch (lane 1 Task 1): the top strip from 1160px (breadcrumb, the stage's
 * tally, the follow-up counts with their definitions), the position strip under it, the guidance aside (risk areas, the
 * folded list), print, the frame's states, and the 1280 by 800 gate (spec 9.3 item 7, joint with lane 2): the decision
 * slot must start at or above 230px with a long real question in the heading, so the card can put "Save decision" inside
 * 800. Screenshots go to this test's output folder (fetched with `remote.sh --fetch`).
 */
const Q = 'Q-PP-01';
const RUNNING = (JSON.parse(readFileSync('data/content/index.json', 'utf8')) as { running: string }).running;
type Bank = { stages: Record<string, { modules: Array<{ questions: Array<{ id: string; text: string }> }> }> };
const realBank = JSON.parse(readFileSync(`data/content/${RUNNING}/questionBank.json`, 'utf8')) as Bank;
/** The real Q-PP-01 (26 words in 5.1.0): the server runs on the fixture bundle, so the gate puts this text in the h1. */
const REAL_Q01 = realBank.stages['pre-processing'].modules.flatMap((m) => m.questions).find((q) => q.id === Q)!.text;
const fixtureBank = JSON.parse(readFileSync('__tests__/fixtures/content/0.0.1-fixture/questionBank.json', 'utf8')) as Bank;
const textOf = (id: string) => fixtureBank.stages['pre-processing'].modules.flatMap((m) => m.questions).find((q) => q.id === id)!.text;

test.beforeEach(async ({ page }) => { failOnDialog(page); });

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  expect(b, `${l} has a box`).not.toBeNull();
  return b!;
};
/**
 * A screenshot for the design review, in test-results/route-T1/ (a fixed folder, so a passing test's pictures are kept),
 * taken with nothing focused, so no focus ring a test left behind is in the picture.
 */
const shot = async (page: Page, _info: TestInfo, name: string, fullPage = false) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `test-results/route-T1/${name}.png`, fullPage });
};

/** The Owner archives the project (route 21). */
async function archive(baseURL: string, projectId: string): Promise<void> {
  const owner = await seatRequest(baseURL, 'owner');
  try {
    const res = await owner.post(`/api/v1/orgs/${fixtureOrgSlug()}/projects/${projectId}/archive`, { data: { requestId: crypto.randomUUID() } });
    expect(res.status(), 'archive').toBeLessThan(300);
  } finally { await owner.dispose(); }
}

/** The Owner opens a stage review of pre-processing and seals it (REV-b's routes), so the current versions are in seal 1. */
async function seal(baseURL: string, projectId: string): Promise<void> {
  const owner = await seatRequest(baseURL, 'owner');
  try {
    const review = await owner.post(`/api/v1/orgs/${fixtureOrgSlug()}/projects/${projectId}/reviews`, { data: { requestId: crypto.randomUUID(), stage: 'pre-processing', preparedFor: null } });
    expect(review.status(), 'open review').toBe(201);
    const { id } = (await review.json()) as { id: string };
    const sealed = await owner.post(`/api/v1/orgs/${fixtureOrgSlug()}/projects/${projectId}/reviews/${id}/seals`, { data: { requestId: crypto.randomUUID() } });
    expect(sealed.status(), 'seal').toBe(201);
  } finally { await owner.dispose(); }
}

test('spec 9.3 item 7 (joint gate): at 1280 by 800, with the real Q-PP-01 in the heading, the decision slot starts at or above 230px', async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const projectId = await newProject(baseURL!);
  expect((await saveViaApi(baseURL!, 'assessor', projectId, 'Q-PP-02', { status: 'partly', reason: 'Two of three in place.' })).status).toBe(201);
  await openQuestion(page, 'assessor', Q, baseURL!, projectId);
  expect(REAL_Q01.split(/\s+/).length, 'a long real question').toBeGreaterThanOrEqual(25);
  await page.locator('#question-heading').evaluate((h, text) => { h.textContent = text; }, REAL_Q01);
  const m = await page.evaluate(() => {
    const h = document.getElementById('question-heading')!;
    const range = document.createRange();
    range.selectNodeContents(h);
    const lines = [...range.getClientRects()];
    const slot = document.querySelector('[data-region="decision-slot"]')!.getBoundingClientRect();
    const top = document.querySelector('.question-top')!.getBoundingClientRect();
    return {
      topStripBottom: Math.round(top.bottom), h1Top: Math.round(h.getBoundingClientRect().top), h1Bottom: Math.round(h.getBoundingClientRect().bottom),
      h1LastLineBottom: Math.round(Math.max(...lines.map((r) => r.bottom))), h1Lines: new Set(lines.map((r) => Math.round(r.top))).size,
      codeBottom: Math.round(document.querySelector('.question-frame__code')!.getBoundingClientRect().bottom), slotTop: Math.round(slot.top),
    };
  });
  info.annotations.push({ type: '1280x800', description: JSON.stringify(m) });
  console.log(`GATE 1280x800 ${JSON.stringify(m)}`);
  await shot(page, info, 'gate-1280x800-real-Q-PP-01');
  expect(m.slotTop, `the decision slot starts at ${m.slotTop}px`).toBeLessThanOrEqual(230);
});

test('R4: the top strip at 1280 is one line of breadcrumb and one of tally, with the follow-up counts as links and their definitions one press away', async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const projectId = await newProject(baseURL!);
  // A Partly raises a finding: the strip shows 1 done, 1 partly, 22 no decision and "1 open finding".
  expect((await saveViaApi(baseURL!, 'assessor', projectId, 'Q-PP-02', { status: 'partly', reason: 'Two of three in place.' })).status).toBe(201);
  expect((await saveViaApi(baseURL!, 'assessor', projectId, 'Q-PP-03', { status: 'done', reason: 'In place.' })).status).toBe(201);
  await openQuestion(page, 'assessor', Q, baseURL!, projectId);
  const strip = page.locator('.question-top');
  await expect(strip).toBeVisible();
  await expect(page.locator('.position-strip')).toBeHidden();
  const crumbs = strip.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs.getByRole('link')).toHaveCount(2);
  await expect(crumbs.getByRole('link', { name: 'Pre-processing', exact: true })).toHaveAttribute('href', `/orgs/${fixtureOrgSlug()}/projects/${projectId}/stages/pre-processing`);
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText('Question 1 of 24');
  await expect(strip.locator('.question-top__tally > li')).toHaveText(['1 done', '1 partly', '22 no decision']);
  const findings = strip.getByRole('link', { name: '1 open finding', exact: true });
  await expect(findings).toHaveAttribute('href', `/orgs/${fixtureOrgSlug()}/projects/${projectId}/findings`);
  await expect(strip.getByText(/overdue mitigation/)).toHaveCount(0);
  // One line each: the tally's line is no taller than one 24px line plus its leading.
  const line = await box(strip.locator('.question-top__line'));
  expect(line.height, 'the tally line is one line at 1280').toBeLessThanOrEqual(30);
  // The definition of "finding" opens from the small button beside the count, and is the link's description.
  const def = page.locator('#question-top-def-finding');
  await expect(def).toBeHidden();
  await strip.getByRole('button', { name: QUESTION_COPY.frame.whatIs('finding') }).click();
  await expect(def).toBeVisible();
  await expect(findings).toHaveAccessibleDescription(/A gap your team has noted/);
  await shot(page, info, 'top-strip-1280-definition-open');
  await page.keyboard.press('Escape');
  await expect(def).toBeHidden();
  await expectNoSeriousA11yViolations(page, 'question page top strip, 1280');
  for (const [w, h] of [[1280, 800], [1366, 768], [1440, 900]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await shot(page, info, `frame-${w}x${h}`);
  }
});

test('narrow: the position strip names its neighbours in words with their place and status, skips nothing that applies, and has no All questions', async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const projectId = await newProject(baseURL!);
  expect((await saveViaApi(baseURL!, 'assessor', projectId, 'Q-PP-02', { status: 'done', reason: 'In place.' })).status).toBe(201);
  await openQuestion(page, 'assessor', 'Q-PP-03', baseURL!, projectId);
  await expect(page.locator('.question-top')).toBeHidden();
  const strip = page.getByRole('navigation', { name: QUESTION_COPY.nav.label, exact: true });
  await expect(strip).toBeVisible();
  // Each name is written in the link's content around the shown number; the name computed in the test runner may space
  // the hidden parts apart, so it is compared with white space folded.
  const folded = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*').replace(/\\\(question\\s\*(\d+),/, '\\(question\\s*$1\\s*,')}$`);
  const prev = strip.getByRole('link', { name: /^Previous question: / });
  const next = strip.getByRole('link', { name: /^Next question: / });
  await expect(prev).toHaveAttribute('href', new RegExp(`/questions/Q-PP-02$`));
  await expect(next).toHaveAttribute('href', new RegExp(`/questions/Q-PP-04$`));
  await expect(prev).toHaveAccessibleName(folded(QUESTION_COPY.frame.previous(textOf('Q-PP-02'), 2, 'Done')));
  await expect(next).toHaveAccessibleName(folded(QUESTION_COPY.frame.next(textOf('Q-PP-04'), 4, 'No decision')));
  await expect(strip.locator('[aria-current="step"]')).toContainText('Question 3 of 24');
  await expect(strip.getByRole('link', { name: QUESTION_COPY.nav.allQuestions })).toHaveCount(0);
  for (const l of [prev, next]) expect((await box(l)).height, 'a 44px target').toBeGreaterThanOrEqual(44);
  // The strip sits directly under the top bar, before the heading.
  expect((await box(strip)).y + (await box(strip)).height).toBeLessThanOrEqual((await box(page.locator('#question-heading'))).y);
  await shot(page, info, 'frame-375x812');
  await shot(page, info, 'frame-375x812-full', true);
  await expectNoSeriousA11yViolations(page, 'question page position strip, 375');
  await next.click();
  await expect(page.locator('#question-heading + .question-frame__code')).toHaveText(/^Q-PP-04 · /);
  await openQuestion(page, 'assessor', Q, baseURL!, projectId);
  await expect(page.getByRole('navigation', { name: QUESTION_COPY.nav.label, exact: true }).getByRole('link', { name: /^Previous question/ })).toHaveCount(0);
});

test('reflow: nothing scrolls sideways at 320 by 640 with the real Q-PP-01 in the heading, both strips and the route column', async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openQuestion(page, 'assessor', 'Q-PP-02', baseURL!);
  await page.locator('#question-heading').evaluate((h, text) => { h.textContent = text; }, REAL_Q01);
  await expectNoHorizontalScroll(page);
  await shot(page, info, 'frame-320x640');
});

test('guidance: the risk areas sit under Why this is asked as links to their cards, and Ways teams address this opens in place from one folded control', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openQuestion(page, 'assessor', Q, baseURL!);
  const aside = page.locator('aside[data-region="guidance"]');
  await expect(aside.getByRole('link', { name: /^Techno-solutionist Bias PP-01$/ })).toHaveAttribute('href', '/explore/framework#area-card-PP-01');
  const ways = aside.locator('details.question-content__ways');
  await expect(ways).not.toHaveAttribute('open', /.*/);
  await expect(page.locator('.suggested-controls__group').first()).toBeHidden();
  await aside.locator('summary', { hasText: /^Ways teams address this \(\d+\)$/ }).click();
  await expect(ways).toHaveAttribute('open', '');
  await expect(ways.locator('.suggested-controls__group').first()).toBeVisible();
  await expect(page.locator('.suggested-controls__group')).toHaveCount(await ways.locator('.suggested-controls__group').count());
});

test('print: the strips, the route column and the form controls are hidden; the question and the guidance stay', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openQuestion(page, 'assessor', Q, baseURL!);
  await page.emulateMedia({ media: 'print' });
  for (const sel of ['.question-top', '.position-strip', '.question-workspace__route', '[data-region="answer-form"] form', '.decision-save-bar'])
    await expect(page.locator(sel).first(), sel).toBeHidden();
  await expect(page.locator('#question-heading')).toBeVisible();
  await expect(page.locator('aside[data-region="guidance"]')).toBeVisible();
  await expect(page.locator('.suggested-controls__group').first(), 'the folded list prints open').toBeVisible();
});

test('frame states (spec 9.7): archived, sealed, switched off, nothing recorded, and the reading view, at 1280 and 375', async ({ page, baseURL }, info) => {
  const projectId = await newProject(baseURL!);
  for (const [w, h] of [[1280, 800], [375, 812]] as const) {
    await page.setViewportSize({ width: w, height: h });
    // Nothing recorded yet: the tally says so, with no follow-up counts.
    await openQuestion(page, 'assessor', Q, baseURL!, projectId);
    await shot(page, info, `state-nothing-recorded-${w}`);
  }
  // Sealed: a decision in seal 1; the seal note sits above the decision slot.
  expect((await saveViaApi(baseURL!, 'assessor', projectId, Q, { status: 'done', reason: 'In place.' })).status).toBe(201);
  await seal(baseURL!, projectId);
  for (const [w, h] of [[1280, 800], [375, 812]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await openQuestion(page, 'assessor', Q, baseURL!, projectId);
    const note = page.locator('section[data-region="seal-note"]');
    await expect(note).toBeVisible();
    expect((await box(note)).y).toBeLessThan((await box(page.locator('[data-region="decision-slot"]'))).y);
    await shot(page, info, `state-sealed-${w}`);
    // The reading view in the same grid.
    await openQuestion(page, 'viewer', Q, baseURL!, projectId);
    await expect(page.locator('[data-region="decision-slot"]')).toHaveCount(0);
    await shot(page, info, `state-reading-viewer-${w}`);
  }
  // Switched off: the personal data question answered No; Q-PP-13 says it does not apply under its code line.
  const assessor = await seatRequest(baseURL!, 'assessor');
  try {
    const res = await assessor.post(`/api/v1/orgs/${fixtureOrgSlug()}/projects/${projectId}/decisions`, { data: {
      requestId: crypto.randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-GATE-SENSITIVE', baseVersionNumber: null,
      status: null, scopeAnswer: 'no', optionsInPlace: [], reasonCode: null, reason: 'The model uses no personal data.',
      decidedBy: { kind: 'outside_role', role: 'supervisor' }, declaredDate: '2026-10-12', evidenceIds: [],
    } });
    expect(res.status(), 'the personal data answer is saved').toBe(201);
  } finally { await assessor.dispose(); }
  for (const [w, h] of [[1280, 800], [375, 812]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await openQuestion(page, 'assessor', 'Q-PP-13', baseURL!, projectId);
    await expect(page.locator('[data-does-not-apply]')).toHaveText(QUESTION_COPY.doesNotApply);
    await shot(page, info, `state-switched-off-${w}`);
  }
  // Archived: the banner at the top of the work area, above the strips.
  await archive(baseURL!, projectId);
  for (const [w, h] of [[1280, 800], [375, 812]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await openQuestion(page, 'owner', Q, baseURL!, projectId);
    const banner = page.getByRole('status').filter({ hasText: /archived/i }).first();
    await expect(banner).toBeVisible();
    const strip = page.locator(w >= 1160 ? '.question-top' : '.position-strip');
    expect((await box(banner)).y).toBeLessThan((await box(strip)).y);
    await expectNoHorizontalScroll(page);
    await shot(page, info, `state-archived-${w}`);
  }
});
