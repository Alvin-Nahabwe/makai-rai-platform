import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { expect, request as pwRequest, test } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { org, seat, signIn } from './helpers/s18';
import { CONTROLS_AFTER_APPROVAL, WORKING_REPORT_PAGE } from '../lib/documents/copy';
import { PROJECT_COPY } from '../lib/project/copy';
import { pdfPageRuns } from '../__tests__/helpers/pdfText';
import { failOnDialog } from './helpers/dialogs';
import { expectNoSeriousA11yViolations } from './helpers/a11y';

/**
 * G1, anti-goals 1, 3 and 4 of "Path to outputs" (design §4, §5): the working report page, `…/projects/<id>/report`. The fixture
 * organisation of e2e/fixtures/manifest.ts; the project, its answers and its open items are made through the real routes with each
 * seat's own session. The fixture content has no approved risk-area mapping, so no control is suggested (anti-goal 3).
 */
const W = PROJECT_COPY.workingReport;

async function api<T>(baseURL: string, role: OrgRole, path: string, data: Record<string, unknown>): Promise<T> {
  const ctx = await pwRequest.newContext({ baseURL, storageState: seat(role).storageStatePath });
  try {
    const res = await ctx.post(path, { data });
    if (!res.ok()) throw new Error(`${path} answered ${res.status()}: ${await res.text()}`);
    return (await res.json()) as T;
  } finally {
    await ctx.dispose();
  }
}

/** A project with one answer that is done and one that is not yet, so page 1 has an open item (the shortfall the second one raises). */
async function projectWithAnswers(baseURL: string): Promise<{ id: string; address: string }> {
  const p = await api<{ id: string }>(baseURL, 'owner', `/api/v1/orgs/${org.slug}/projects`, { requestId: randomUUID(), name: `Working report ${randomUUID().slice(0, 8)}`, aiSystemType: 'classification' });
  const decide = (questionId: string, status: string, reasonCode: string | null = null) => api(baseURL, 'assessor', `/api/v1/orgs/${org.slug}/projects/${p.id}/decisions`, {
    requestId: randomUUID(), stage: 'pre-processing', questionId, baseVersionNumber: null, status, scopeAnswer: null, optionsInPlace: [],
    reasonCode, reason: `End-to-end reason ${randomUUID()} for this decision.`, decidedBy: { kind: 'outside_role', role: 'principal_investigator' },
    declaredDate: '2026-10-30', evidenceIds: [],
  });
  await decide('Q-PP-12', 'done');
  await decide('Q-PP-01', 'not_yet', 'ny_planned_later');
  return { id: p.id, address: `/orgs/${org.slug}/projects/${p.id}/report` };
}

test('G1: a Viewer opens the working report and downloads the whole PDF', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  failOnDialog(page);
  const project = await projectWithAnswers(baseURL!);
  await signIn(page, 'viewer');
  await page.goto(project.address);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(PROJECT_COPY.titles.workingReport);
  await expect(page.getByRole('heading', { level: 2, name: WORKING_REPORT_PAGE.title })).toBeVisible();
  await expect(page.locator('[data-report-draft]')).toContainText(/^Draft · from answers as of /);
  const whole = page.getByRole('link', { name: W.downloadAll });
  const [download] = await Promise.all([page.waitForEvent('download'), whole.click()]);
  expect(download.suggestedFilename()).toMatch(/^working-report-draft-\d{4}-\d{2}-\d{2}-all\.pdf$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  expect(Buffer.concat(chunks).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  // One link per part the PDF holds, in its order: page 1, the two cards, and the plan of the one stage with answers.
  const parts = page.getByRole('list', { name: W.partsHeading }).getByRole('link');
  await expect(parts).toHaveCount(4);
  expect(await parts.evaluateAll((as) => as.map((a) => new URL((a as HTMLAnchorElement).href).searchParams.get('part'))))
    .toEqual(['summary', 'data_card', 'model_card', 'mitigation_plan:pre-processing']);
});

test('anti-goal 1: scrolled to the middle of the draft data card, the draft line is inside the viewport', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const project = await projectWithAnswers(baseURL!);
  await signIn(page, 'viewer');
  await page.goto(project.address);
  const field = page.locator('#field-data_card-DC-17');
  await field.scrollIntoViewIfNeeded();
  await field.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const banner = page.locator('[data-report-draft]');
  await expect(banner).toBeVisible();
  const box = await banner.boundingBox();
  const view = page.viewportSize();
  expect(box, 'the banner has a box').not.toBeNull();
  expect(view, 'the page has a viewport').not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(view!.height);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(view!.width);
  // The field really is in the middle of the page, so the test has scrolled.
  expect(await page.evaluate(() => Math.max(window.scrollY, ...Array.from(document.querySelectorAll('*')).map((e) => e.scrollTop)))).toBeGreaterThan(300);
});

test('anti-goal 1: a browser printout of the report carries the draft line on every page', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const project = await projectWithAnswers(baseURL!);
  await signIn(page, 'viewer');
  await page.goto(project.address);
  const line = (await page.locator('[data-report-draft]').innerText()).replace(/\s+/g, ' ').trim();
  expect(line).toMatch(/^Draft · from answers as of /);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ media: 'print', colorScheme });
    const pdf = await page.pdf({ format: 'A4' });
    const pages = pdfPageRuns(pdf).map((runs) => runs.join('').replace(/\s+/g, ' '));
    expect(pages.length, `the ${colorScheme} printout runs over several pages`).toBeGreaterThan(1);
    const squash = (s: string) => s.replace(/\s+/g, '');
    pages.forEach((text, i) => expect(squash(text), `${colorScheme} printed page ${i + 1} carries the draft line`).toContain(squash(line)));
  }
});

test('anti-goal 3: with fixture content, no control is suggested on page 1', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const project = await projectWithAnswers(baseURL!);
  await signIn(page, 'viewer');
  await page.goto(project.address);
  const summary = page.locator('#report-summary');
  // Not vacuous: page 1 does list an open item, so a suggested control would have a place to appear.
  await expect(summary.getByRole('heading', { level: 3, name: WORKING_REPORT_PAGE.nextSteps })).toBeVisible();
  expect(await summary.locator('[data-open-item]').count(), 'page 1 lists at least one open item').toBeGreaterThan(0);
  await expect(summary).toContainText(CONTROLS_AFTER_APPROVAL);
  await expect(summary.getByText(WORKING_REPORT_PAGE.controls, { exact: true })).toHaveCount(0);
  await expect(summary.locator('[data-control]')).toHaveCount(0);
  await expect(summary.getByText(WORKING_REPORT_PAGE.hasNotebook)).toHaveCount(0);
});

test('anti-goal 4: the page holds no control a role can see and not use (links only, no button or field)', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const project = await projectWithAnswers(baseURL!);
  for (const role of ['viewer', 'owner'] as const) {
    await signIn(page, role);
    await page.goto(project.address);
    await expect(page.locator('[data-report-draft]')).toBeVisible();
    await expectNoSeriousA11yViolations(page, `working report, ${role}`);
    await expect(page.locator('main').getByRole('button')).toHaveCount(0);
    await expect(page.locator('main').getByRole('textbox')).toHaveCount(0);
    // Every download link answers 200 for that role, so none is shown and then refused.
    const hrefs = await page.locator('main a[href*="/working-report"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
    expect(hrefs.length).toBeGreaterThan(1);
    for (const href of hrefs) expect((await page.request.get(href)).status(), `${role}: ${href}`).toBe(200);
  }
});

test('a project id that is not a project is the 404, for the page and for a person of another organisation', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const project = await projectWithAnswers(baseURL!);
  await signIn(page, 'viewer');
  for (const bad of [`/orgs/${org.slug}/projects/not-a-uuid/report`, `/orgs/${org.slug}/projects/${randomUUID()}/report`, `/orgs/no-such-org/projects/${project.id}/report`]) {
    const res = await page.goto(bad);
    expect([bad, res?.status()]).toEqual([bad, 404]);
  }
});

test('the rail shows Working report inside a project and nowhere else', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const project = await projectWithAnswers(baseURL!);
  await signIn(page, 'viewer');
  const inRail = page.locator('nav.shell-rail .shell-project').getByRole('link', { name: W.railLink, exact: true });
  for (const inside of [`/orgs/${org.slug}/projects/${project.id}`, project.address, `/orgs/${org.slug}/projects/${project.id}/stages/pre-processing`]) {
    await page.goto(inside);
    await expect(inRail, inside).toHaveCount(1);
  }
  await expect(inRail).toHaveAttribute('href', project.address);
  for (const outside of [`/orgs/${org.slug}/dashboard`, `/orgs/${org.slug}/projects`, '/account']) {
    await page.goto(outside);
    await expect(page.getByRole('link', { name: W.railLink, exact: true }), outside).toHaveCount(0);
  }
  // Leaving the project by a soft navigation takes the entry with the block.
  await page.goto(project.address);
  await expect(inRail).toHaveCount(1);
  await page.locator('nav.shell-rail').getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page).toHaveURL(`/orgs/${org.slug}/projects`);
  await expect(page.getByRole('link', { name: W.railLink, exact: true })).toHaveCount(0);
});
