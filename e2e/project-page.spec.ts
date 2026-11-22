import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
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
import { TERM_DOES_NOT_APPLY, TERM_DONE, TERM_NOT_APPLICABLE, TERM_NOT_YET, TERM_PARTLY } from '../lib/vocabulary/terms';
import { closeOpenedContexts } from './helpers/contexts';

// Every context a test opened is closed after it (helpers/contexts.ts says why).
test.afterEach(closeOpenedContexts);

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
let ipSeq = 0;
const nextClientIp = () => `10.83.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

async function signedIn(browser: Browser, account: Pick<FixtureAccount, 'email' | 'password'>, js = true): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': nextClientIp() } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
  if (js) return page;
  const off = await browser.newContext({ javaScriptEnabled: false, storageState: await context.storageState() });
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
  // One Done decision in each stage, through the route with the owner's own session. Then every other status word a tally
  // defines (lane 4 Task B): No to the personal data question, so two pre-processing questions do not apply; and in
  // in-processing one Partly, one Not yet and one Not applicable. Pre-processing's tally first uses "done" and "does not
  // apply", in-processing's the other three.
  const owner = await signedIn(browser, fx.members.owner);
  const SEEDS: ReadonlyArray<readonly [string, string, 'done' | 'partly' | 'not_yet' | 'not_applicable' | null, string | null]> = [
    ['pre-processing', 'Q-PP-01', 'done', null], ['in-processing', 'Q-IP-01', 'done', null], ['post-processing', 'Q-PO-01', 'done', null],
    ['pre-processing', 'Q-PP-GATE-SENSITIVE', null, null], ['in-processing', 'Q-IP-02', 'partly', null],
    ['in-processing', 'Q-IP-03', 'not_yet', 'ny_planned_later'], ['in-processing', 'Q-IP-04', 'not_applicable', 'na_answered_elsewhere'],
  ];
  for (const [stage, questionId, status, reasonCode] of SEEDS) {
    const res = await owner.context().request.post(`/api/v1/orgs/${fx.org.slug}/projects/${project.id}/decisions`, {
      headers: { origin: new URL(owner.url()).origin },
      data: {
        requestId: randomUUID(), stage, questionId, baseVersionNumber: null, status, scopeAnswer: status === null ? 'no' : null, optionsInPlace: [],
        reasonCode, reason: `Seeded reason ${randomUUID()} for this decision.`, decidedBy: { kind: 'outside_role', role: 'principal_investigator' },
        declaredDate: '2026-10-30', evidenceIds: [],
      },
    });
    if (!res.ok()) throw new Error(`seeding ${questionId} answered ${res.status()}: ${await res.text()}`);
  }
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

/**
 * The page's one primary action: "Open the working report" (G5, owner-approved 19 Nov 2026), which supersedes ruling C3 of
 * 15 Nov ("the primary carries the next question"). Each stage's own link, "Next: Question N · Continue", is a plain link.
 */
for (const [width, height] of [[1280, 800], [1440, 900], [375, 812]] as const) {
  test(`G5 (supersedes C3): at ${width} px exactly one primary action, Open the working report, is in the accessibility tree and inside the first view, under the what-you-get line`, async ({ browser }) => {
    const page = await signedIn(browser, fx.members.owner);
    await page.setViewportSize({ width, height });
    await page.goto(projectPath(project.id));
    const primary = page.getByRole('link', { name: PROJECT_COPY.overview.openReport, exact: true });
    await expect(primary).toHaveCount(1);
    await expect(primary).toBeVisible();
    await expect(primary).toHaveAttribute('href', `${projectPath(project.id)}/report`);
    await expect(page.locator('main .ui-button--primary')).toHaveCount(1);
    const box = await primary.boundingBox();
    expect(box!.y + box!.height, `the button's foot (${Math.round(box!.y + box!.height)} px) is inside the ${height} px first view`).toBeLessThanOrEqual(height);
    const line = await page.getByText(PROJECT_COPY.overview.whatYouGet, { exact: true }).boundingBox();
    expect(line!.y).toBeLessThan(box!.y);
    // G4: every stage has its bar, named in words, and a plain link to its next question.
    for (const s of STAGES) {
      const bar = page.locator(`#${s} [data-stage-bar] progress`);
      await expect(bar).toHaveCount(1);
      // M4: named by the visible words (aria-labelledby), so the sentence is announced once, not twice.
      await expect(bar).toHaveAccessibleName(/^\d+ of \d+ questions recorded$/);
      await expect(bar).not.toHaveAttribute('aria-label');
      await expect(page.locator(`#${s}`).getByRole('link', { name: /^Next: Question \d+ · Continue$/ })).toHaveCount(1);
    }
  });
}

test('I4 (owner 15 Nov 19:20, count not names): at 1440x900 the actions row and every line\'s end stop are inside the first view, with the page scrolled to 0', async ({ browser }) => {
  // A project of its own with nothing recorded yet, as the finish review captured it: every stage shows its full row of
  // marks, the first-use definitions and the empty Reviews stop.
  const fresh = await addProject(fx, { name: `Lines fit ${RUN}` });
  const page = await signedIn(browser, fx.members.assessor);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(projectPath(fresh.id));
  await expect(page.locator('.stage-line__named')).toHaveCount(0);
  const feet = await page.evaluate(() => {
    const bottom = (el: Element | null) => (el === null ? null : Math.round(el.getBoundingClientRect().bottom));
    return {
      scroll: document.querySelector('div.page-frame')?.scrollTop ?? 0,
      lastStops: [...document.querySelectorAll('.stage-line__stop--last')].map(bottom),
      actions: bottom(document.querySelector('nav.project-actions')),
    };
  });
  expect(feet.scroll).toBe(0);
  expect(feet.lastStops, 'one end stop per line').toHaveLength(3);
  expect(feet.actions, `actions row foot ${feet.actions}`).not.toBeNull();
  for (const b of [...feet.lastStops, feet.actions]) expect(b, `foot ${b} px of ${JSON.stringify(feet)}`).toBeLessThanOrEqual(900);
});

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

/** The status words a tally defines, each with the stage whose tally first shows it in this spec's project. */
const STATUS_TIPS = [
  [TERM_DONE, 'pre-processing'], [TERM_DOES_NOT_APPLY, 'pre-processing'],
  [TERM_PARTLY, 'in-processing'], [TERM_NOT_YET, 'in-processing'], [TERM_NOT_APPLICABLE, 'in-processing'],
] as const;

test('owner\'s ruling 11:05: each status word\'s (i), once on the page in the first tally that shows it, opens its sentence by keyboard and by pointer', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(projectPath(project.id));
  const main = page.locator('main');
  for (const [term, stage] of STATUS_TIPS) {
    const button = main.getByRole('button', { name: PROJECT_COPY.whatMeans(term.term), exact: true });
    await expect(button, term.id).toHaveCount(1);
    await expect(page.locator(`#${stage} .ui-route-row__tally`).getByRole('button', { name: PROJECT_COPY.whatMeans(term.term), exact: true }), term.id).toHaveCount(1);
    const tip = page.locator(`#term-tip-${term.id}`);
    // The sentence is the vocabulary's, word for word, and the button is described by it.
    await expect(tip.locator(`[data-definition="${term.id}"]`)).toHaveText(term.definition);
    await expect(button).toHaveAccessibleDescription(term.definition);
    await expect(tip).toBeHidden();
    // Keyboard (a toggletip, lane 1's 6eb9f584): Tab onto the button opens nothing; Enter (Space on the first) opens the
    // sentence; Escape closes it and focus stays on the button.
    await button.evaluate((el) => {
      const all = Array.from(document.querySelectorAll<HTMLElement>('a[href], button, [tabindex]:not([tabindex="-1"])'));
      all[all.indexOf(el as HTMLElement) - 1].focus();
    });
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    await expectFocusVisibleAndUncovered(page);
    await expect(tip, `${term.id}: focus alone opens nothing`).toBeHidden();
    await page.keyboard.press(term === STATUS_TIPS[0][0] ? 'Space' : 'Enter');
    await expect(tip, `${term.id} by keyboard`).toBeVisible();
    await expect(tip.locator(`[data-definition="${term.id}"]`)).toHaveText(term.definition);
    await page.keyboard.press('Escape');
    await expect(tip).toBeHidden();
    await expect(button, `${term.id}: focus stays on the (i)`).toBeFocused();
    // Pointer: a press shows it; a press elsewhere closes it.
    await button.click();
    await expect(tip, `${term.id} by pointer`).toBeVisible();
    await page.locator('h1').click();
    await expect(tip).toBeHidden();
  }
  // "No decision" and the answered personal data question carry none.
  await expect(main.locator('.ui-term-tip [data-definition="no-decision"], .ui-term-tip [data-definition="personal-data-question-scope-question"]')).toHaveCount(0);
});

test('K2: at 320 px no count parts from its word, the (i) stays beside the word, every item stays inside its list; no horizontal scroll', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(projectPath(project.id));
  const items = page.locator('main .ui-route-row__tally-item');
  expect(await items.count()).toBeGreaterThanOrEqual(STATUS_TIPS.length);
  const facts = await items.evaluateAll((els) => els.map((el) => {
    const count = el.querySelector('.ui-route-row__tally-word')!;
    const tip = el.querySelector('.ui-term-tip');
    const caveat = el.querySelector('.ui-route-row__tally-caveat');
    const c = count.getBoundingClientRect();
    const t = tip?.getBoundingClientRect();
    return {
      text: el.textContent, right: el.getBoundingClientRect().right, listRight: el.closest('ul')!.getBoundingClientRect().right,
      // An inline part on one line is one line box tall (under two font sizes); on two it would be two 24 px lines.
      countOneLine: c.height < 2 * parseFloat(getComputedStyle(count).fontSize),
      caveatOneLine: caveat === null || caveat.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(caveat).fontSize),
      // The (i) on the same line as the word, right after it.
      tipBeside: t === undefined || (Math.abs(t.top + t.height / 2 - (c.top + c.height / 2)) < 4 && t.left >= c.right - 1 && t.left - c.right < 12),
    };
  }));
  for (const f of facts) {
    expect(f.countOneLine, `${f.text}: the count and its word on one line`).toBe(true);
    expect(f.caveatOneLine, `${f.text}: the caveat on one line`).toBe(true);
    expect(f.tipBeside, `${f.text}: the (i) beside the word`).toBe(true);
    expect(f.right, `${f.text}: inside its list`).toBeLessThanOrEqual(f.listRight + 0.5);
  }
  await expectNoHorizontalScroll(page);

  // M4: with only the text enlarged to 200% (the root font size), no tally item overlaps another, and within an item the
  // count's unit and the caveat do not overlap: the line height is unitless and the 24 px is a minimum.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const overlaps = await page.locator('main ul.ui-route-row__tally').evaluateAll((lists) => {
    const hit = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const out: string[] = [];
    for (const list of lists) {
      const items = Array.from(list.querySelectorAll('.ui-route-row__tally-item'));
      items.forEach((a, i) => items.slice(i + 1).forEach((b) => { if (hit(a.getBoundingClientRect(), b.getBoundingClientRect())) out.push(`${a.textContent} / ${b.textContent}`); }));
      for (const item of items) {
        const count = item.querySelector('.ui-route-row__tally-count')!.getBoundingClientRect();
        const caveat = item.querySelector('.ui-route-row__tally-caveat')?.getBoundingClientRect();
        if (caveat !== undefined && hit(count, caveat)) out.push(`${item.textContent}: count and caveat`);
      }
    }
    return out;
  });
  expect(overlaps, 'overlapping tally parts at 200% text').toEqual([]);
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
  // The one primary is the working report (G5), which an archived project keeps: reading it writes nothing.
  await expect(page.locator('main .ui-button--primary')).toHaveText(PROJECT_COPY.overview.openReport);
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
