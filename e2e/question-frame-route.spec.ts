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
 * 800. Screenshots go to this test's output folder (fetched with `remote.sh --fetch`). Since the join (lane 2 task 4) the
 * slot holds the decision card alone, `[data-region="answer-form"]`, so the slot's top is the card's top; a reader gets no
 * card.
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
  await page.screenshot({ path: `test-results/route-T1/${name}.png`, fullPage, animations: 'disabled' });
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
    const slot = document.querySelector('[data-region="answer-form"]')!.getBoundingClientRect();
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

/** Saves a decision with a status and, for Not yet and Not applicable, a main reason (the fixture's codes), as the Assessor. */
async function decide(baseURL: string, projectId: string, questionId: string, status: string, reasonCode: string | null = null): Promise<void> {
  const ctx = await seatRequest(baseURL, 'assessor');
  try {
    const res = await ctx.post(`/api/v1/orgs/${fixtureOrgSlug()}/projects/${projectId}/decisions`, { data: {
      requestId: crypto.randomUUID(), stage: 'pre-processing', questionId, baseVersionNumber: null,
      status: questionId === 'Q-PP-GATE-SENSITIVE' ? null : status, scopeAnswer: questionId === 'Q-PP-GATE-SENSITIVE' ? 'no' : null,
      optionsInPlace: [], reasonCode, reason: `Seeded ${status} for the full tally.`,
      decidedBy: { kind: 'outside_role', role: 'supervisor' }, declaredDate: '2026-10-12', evidenceIds: [],
    } });
    expect(res.status(), `${questionId} ${status}`).toBe(201);
  } finally { await ctx.dispose(); }
}

/**
 * The full tally the sketch draws, at two digits (fix round 1, I1; owner's ruling of 11:00): the project gets one real
 * decision of every kind (done, partly, not yet, not applicable, the personal data question at No, so two do not apply),
 * which raises real open findings; then, because the fixture stage has 24 questions, the counts are set in the page to
 * the two-digit numbers (9 done, 16 partly, 12 not yet, 1 not applicable, 2 do not apply, 1 answered, 13 no decision,
 * 11 open findings) and, since the fixture has no overdue mitigation, an "1 overdue mitigation" count with its (i) is
 * cloned from the open-findings one. Returns the strip's measures.
 */
async function fullTally(page: Page, baseURL: string, info: TestInfo, label: string) {
  const m = await page.evaluate(() => {
    const strip = document.querySelector('.question-top')!;
    const numbers: Record<string, string> = { done: '9', partly: '16', not_yet: '12', not_applicable: '1', does_not_apply: '2', scope_answered: '1', no_decision: '13' };
    for (const li of strip.querySelectorAll<HTMLElement>('.question-top__tally > li')) {
      const b = li.querySelector('b');
      const n = numbers[li.dataset.markKind ?? ''];
      if (b !== null && n !== undefined) b.textContent = n;
    }
    const finding = strip.querySelector<HTMLElement>('.question-top__count')!;
    finding.querySelector('[data-term="finding"]')!.textContent = '11 open findings';
    if (strip.querySelectorAll('.question-top__count').length === 1) {
      const overdue = finding.cloneNode(true) as HTMLElement;
      overdue.querySelector('a')!.classList.add('question-top__overdue');
      overdue.querySelector('[data-term]')!.textContent = '1 overdue mitigation';
      overdue.querySelector('a')!.prepend(finding.querySelector('.ui-term-tip__button svg')!.cloneNode(true));
      for (const el of overdue.querySelectorAll('[id]')) el.id = `${el.id}-clone`;
      finding.after(overdue);
    }
    const tally = strip.querySelector<HTMLElement>('.question-top__tally')!;
    const crumbs = strip.querySelector<HTMLElement>('.ui-breadcrumb')!;
    const follow = strip.querySelector<HTMLElement>('.question-top__follow')!;
    const items = [...tally.children] as HTMLElement[];
    const gap = parseFloat(getComputedStyle(tally).columnGap);
    const tallyNeeds = Math.round(items.reduce((w, li) => w + li.getBoundingClientRect().width, 0) + gap * (items.length - 1));
    const lineTops = new Set(items.map((li) => Math.round(li.getBoundingClientRect().top)));
    // An item broken across rows would be taller than one line (each is one 24px unit).
    const splitItems = items.filter((li) => li.getBoundingClientRect().height > 30).length;
    const r = (el: Element) => el.getBoundingClientRect();
    return {
      stripWidth: Math.round(r(strip).width), stripTop: Math.round(r(strip).top), stripBottom: Math.round(r(strip).bottom),
      tallyNeeds, tallyHas: Math.round(tally.clientWidth), tallyRows: lineTops.size, tallyHeight: Math.round(r(tally).height), splitItems,
      crumbsWidth: Math.round(r(crumbs).width), followWidth: Math.round(r(follow).width),
      crumbsRowTop: Math.round(r(crumbs).top), followTop: Math.round(r(follow).top), tips: strip.querySelectorAll('.ui-term-tip__button').length,
    };
  });
  const slot = await page.evaluate(() => {
    const h = document.getElementById('question-heading')!;
    const range = document.createRange();
    range.selectNodeContents(h);
    return {
      h1LastLineBottom: Math.round(Math.max(...[...range.getClientRects()].map((x) => x.bottom))),
      slotTop: Math.round(document.querySelector('[data-region="answer-form"]')!.getBoundingClientRect().top),
    };
  });
  const all = { ...m, ...slot };
  info.annotations.push({ type: label, description: JSON.stringify(all) });
  console.log(`FULL ${label} ${JSON.stringify(all)}`);
  return all;
}

/** Seeds one real decision of every kind in a new project named `name`, for the full tally. */
async function seedEveryKind(baseURL: string, name?: string): Promise<string> {
  const projectId = await newProject(baseURL, name);
  for (const id of ['Q-PP-02', 'Q-PP-03', 'Q-PP-04']) await decide(baseURL, projectId, id, 'done');
  for (const id of ['Q-PP-05', 'Q-PP-06']) await decide(baseURL, projectId, id, 'partly');
  await decide(baseURL, projectId, 'Q-PP-07', 'not_yet', 'ny_planned_later');
  await decide(baseURL, projectId, 'Q-PP-08', 'not_applicable', 'na_other');
  await decide(baseURL, projectId, 'Q-PP-GATE-SENSITIVE', 'scope');
  return projectId;
}

test('fix rounds 1-2 (I1, N1, owners 11:00 and 12:28): the full tally with every (i): one row at 1440, at most two at 1280 and 1160 breaking only between items; long project names at 1280 keep the breadcrumb one line', async ({ page, baseURL }, info) => {
  const results: Record<string, Awaited<ReturnType<typeof fullTally>>> = {};
  const projectId = await seedEveryKind(baseURL!);
  for (const [w, h] of [[1280, 800], [1440, 900], [1160, 800]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await openQuestion(page, 'assessor', Q, baseURL!, projectId);
    await page.locator('#question-heading').evaluate((el, text) => { el.textContent = text; }, REAL_Q01);
    // Every kind is really there before the numbers are raised.
    await expect(page.locator('.question-top__tally > li')).toHaveCount(7);
    results[`${w}x${h}`] = await fullTally(page, baseURL!, info, `${w}x${h}`);
    await shot(page, info, `full-tally-${w}x${h}`);
  }
  // N1: project names of 60 and 200 characters (the limit) at 1280: the breadcrumb stays one line, cut with an ellipsis,
  // so the slot is where it is with the fixture's short name.
  for (const length of [60, 200]) {
    const name = `Antenatal Risk Triage Model ${'for the fourteen centres of the region '.repeat(6)}`.slice(0, length - 6).trimEnd().padEnd(length - 6, 's')
      + ` ${String(Date.now()).slice(-5)}`;
    expect(name.length).toBe(length);
    const longId = await seedEveryKind(baseURL!, name);
    await page.setViewportSize({ width: 1280, height: 800 });
    await openQuestion(page, 'assessor', Q, baseURL!, longId);
    await page.locator('#question-heading').evaluate((el, text) => { el.textContent = text; }, REAL_Q01);
    const project = page.locator('.question-top .ui-breadcrumb').getByRole('link', { name, exact: true });
    await expect(project, 'the link keeps the whole name as its text').toHaveCount(1);
    results[`1280x800-name${length}`] = await fullTally(page, baseURL!, info, `1280x800-name${length}`);
    const crumbs = await box(page.locator('.question-top .ui-breadcrumb'));
    expect(crumbs.height, `the breadcrumb is one line with a ${length}-character name`).toBeLessThanOrEqual(30);
    expect(results[`1280x800-name${length}`].slotTop, `slot with a ${length}-character name`).toBe(results['1280x800'].slotTop);
    await shot(page, info, `full-tally-1280x800-name${length}`);
  }
  // The owner's ruling of 12:28 (option a): one row from 1440; below it at most two rows, breaking only between items.
  expect(results['1280x800'].tips, 'every (i): two counts, five status words, the personal data question').toBe(8);
  expect(results['1440x900'].tallyRows, 'one row at 1440').toBe(1);
  for (const key of ['1280x800', '1160x800']) {
    expect(results[key].tallyRows, `${key}: at most two rows`).toBeLessThanOrEqual(2);
    expect(results[key].splitItems, `${key}: no item broken across rows`).toBe(0);
  }
  expect(results['1280x800'].followTop, 'the follow-up counts are on the breadcrumb\'s row').toBeLessThanOrEqual(results['1280x800'].crumbsRowTop + 4);
  // Recorded for lane 2 (the card is sized from it): about 250px at 1280x800 with the full tally on two rows.
  expect(results['1280x800'].slotTop, `the decision slot starts at ${results['1280x800'].slotTop}px at 1280x800`).toBeLessThanOrEqual(260);
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
  // Each item's text starts with its count and words (a defined word's (i) holds its definition after them, hidden).
  await expect(strip.locator('.question-top__tally > li')).toHaveText([/^1 done/, /^1 partly/, /^22 no decision$/]);
  const findings = strip.getByRole('link', { name: '1 open finding', exact: true });
  await expect(findings).toHaveAttribute('href', `/orgs/${fixtureOrgSlug()}/projects/${projectId}/findings`);
  await expect(strip.getByText(/overdue mitigation/)).toHaveCount(0);
  // One line each: the tally's line is no taller than one 24px line plus its leading.
  const line = await box(strip.locator('.question-top__tally'));
  expect(line.height, 'the tally is one line at 1280').toBeLessThanOrEqual(30);
  // TermTip, a toggletip (coordinator's ruling, fix round 2): focus alone opens nothing; Enter or Space on the focused (i)
  // opens it and a second press closes it; Escape closes it; a click opens it; a press inside keeps it open; focus leaving
  // closes it. The link is described by it. The sentence is the vocabulary's.
  const def = page.locator('#term-tip-finding-def');
  const tip = strip.getByRole('button', { name: QUESTION_COPY.frame.whatIs('finding') });
  await expect(def).toBeHidden();
  await tip.focus();
  await page.waitForTimeout(300);
  await expect(def, 'focus alone opens nothing').toBeHidden();
  await page.keyboard.press('Enter');
  await expect(def, 'Enter opens it').toBeVisible();
  await expect(def).toHaveText('A gap your team has noted for a question, so it can be dealt with and closed.');
  await expect(tip).toHaveAttribute('aria-describedby', 'term-tip-finding-def');
  await page.screenshot({ path: 'test-results/route-T1/top-strip-1280-definition-open.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(def, 'Escape closes it').toBeHidden();
  await expect(tip).toBeFocused();
  await page.keyboard.press('Space');
  await expect(def, 'Space opens it').toBeVisible();
  await page.keyboard.press('Space');
  await expect(def, 'a second press closes it').toBeHidden();
  await tip.click();
  await expect(def, 'a click opens it').toBeVisible();
  const d = await box(def);
  await page.mouse.click(d.x + 8, d.y + d.height / 2);
  await expect(def, 'a press inside the open tip keeps it open').toBeVisible();
  await page.mouse.click(700, 600);
  await expect(def, 'a press elsewhere closes it').toBeHidden();
  await tip.click();
  await expect(def).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(def, 'focus leaving closes it').toBeHidden();
  await expect(findings).toHaveAccessibleDescription(/A gap your team has noted/);
  // A status word's (i): "Partly" is defined, so it has one; a press opens its sentence.
  const partly = strip.getByRole('button', { name: QUESTION_COPY.frame.whatMeans('Partly') });
  await partly.click();
  await expect(page.locator('#term-tip-partly-def')).toHaveText('Some of it is in place, but not all of it.');
  await expect(page.locator('#term-tip-partly-def')).toBeVisible();
  const box24 = await box(partly);
  expect(Math.min(box24.width, box24.height), 'a 24px target').toBeGreaterThanOrEqual(24);
  await page.keyboard.press('Escape');
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

test('reflow: nothing scrolls sideways at 320 by 640 with the real Q-PP-01 in the heading, both strips and the route column; on Q-PP-22 (question 23) the strip\'s three items do not overlap', async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openQuestion(page, 'assessor', 'Q-PP-22', baseURL!);
  await page.locator('#question-heading').evaluate((h, text) => { h.textContent = text; }, REAL_Q01);
  await expectNoHorizontalScroll(page);
  // Two-digit neighbours (21 and 23) and "22 of 24": previous link, ring, place, next link, left to right, apart.
  const strip = page.locator('.position-strip');
  const prev = await box(strip.getByRole('link', { name: /^Previous question/ }));
  const ring = await box(strip.locator('.position-strip__ring'));
  const place = await box(strip.locator('.position-strip__here b'));
  const next = await box(strip.getByRole('link', { name: /^Next question/ }));
  expect(prev.x + prev.width, 'the previous link ends before the ring').toBeLessThanOrEqual(ring.x);
  expect(ring.x + ring.width).toBeLessThanOrEqual(place.x);
  expect(place.x + place.width, 'the place ends before the next link').toBeLessThanOrEqual(next.x);
  expect(next.x + next.width).toBeLessThanOrEqual(320);
  // Q-PP-22 is the stage's 23rd question (the personal data question sits among them): two-digit numbers either way.
  await expect(strip.locator('.position-strip__here')).toContainText('23 of 24');
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

// Quarantined by the owner's decision of 20 Nov 2026 (question box: "Quarantine, design later (Recommended)"): the print
// rules hide classes the decision card no longer renders, and hiding the form would drop the decision from the printout.
// Register D-423: print a writer's saved decision as text, then lift this fixme. v0.8.0 shipped it failing (v0.8.0.md:108).
test.fixme('print: the strips, the route column and the form controls are hidden; the question and the guidance stay', async ({ page, baseURL }) => {
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
    expect((await box(note)).y).toBeLessThan((await box(page.locator('[data-region="answer-form"]'))).y);
    await shot(page, info, `state-sealed-${w}`);
    // The reading view in the same grid.
    await openQuestion(page, 'viewer', Q, baseURL!, projectId);
    await expect(page.locator('[data-region="answer-form"]')).toHaveCount(0);
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
