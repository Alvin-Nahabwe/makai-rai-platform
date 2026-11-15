import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  addFinding, addMitigationVersion, addProject, addStageReview, buildOrg, type FixtureAccount, type OrgFixture,
} from '../__tests__/helpers/recordFixture';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { HOME_COPY } from '../lib/home/copy';
import { PROJECT_COPY } from '../lib/project/copy';

/**
 * Home, every variant, in a browser (plan 1B Task 10, step 2; spec 9.1): each seat of this spec's own organisation sees
 * its variant's headings (an Owner and an Admin the lead lists above the stages, an Assessor the next step, a Reviewer
 * the three review lists, a Viewer the last 14 days and what is still open); a new organisation shows the first visit,
 * with "Create a project" for an Owner and the ask line for a Viewer; no serious axe violation in both themes at 1280,
 * 375 and 320 px and no sideways scroll with a 70-character project name. Each case signs in on the login page, as
 * e2e/home-next-step.spec.ts does; the records are made with the record fixture builder.
 */
const RUN = randomUUID().slice(0, 8);
// 70 characters, one long word among them, so every place the name appears must wrap it.
const LONG_NAME = `Home ${RUN} Antenatal-risk-triage-for-district-hospitals-and-clinics project`.padEnd(70, 'x').slice(0, 70);

let fx: OrgFixture;
let fresh: OrgFixture;
let starting: OrgFixture;
let project: { id: string };
const contexts: BrowserContext[] = [];
let ipSeq = 0;
const nextClientIp = () => `10.81.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

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

const homeOf = (f: OrgFixture) => `/orgs/${f.org.slug}/dashboard`;
const h2 = (page: Page, name: string) => page.getByRole('heading', { level: 2, name, exact: true });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  fx = await buildOrg({ label: 'home' });
  fresh = await buildOrg({ label: 'homenew' });
  starting = await buildOrg({ label: 'homestart' });
  await addProject(starting, { name: `Start ${RUN}` });
  project = await addProject(fx, { name: LONG_NAME });
  // An overdue mitigation (the Owner's and Admin's first list), a finding with no mitigation (their second), the
  // Reviewer's own open finding, and a stage review not sealed yet.
  const overdue = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team' });
  await addMitigationVersion(fx, overdue.id, { status: 'planned', owner: 'assessor', dueDate: '2026-01-15' });
  await addFinding(fx, project.id, { stage: 'in-processing', source: 'team', by: 'reviewer' });
  await addStageReview(fx, project.id, { stage: 'pre-processing' });
  // One decision saved by the assessor through the route, with the assessor's own session.
  const assessor = await signedIn(browser, fx.members.assessor);
  const res = await assessor.context().request.post(`/api/v1/orgs/${fx.org.slug}/projects/${project.id}/decisions`, {
    headers: { origin: new URL(assessor.url()).origin },
    data: {
      requestId: randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-02', baseVersionNumber: null, status: 'partly', scopeAnswer: null,
      optionsInPlace: [], reasonCode: null, reason: `Seeded reason ${randomUUID()} for this decision.`,
      decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, declaredDate: '2026-10-30', evidenceIds: [],
    },
  });
  if (!res.ok()) throw new Error(`seeding Q-PP-02 answered ${res.status()}: ${await res.text()}`);
});

test.afterAll(async () => {
  await Promise.all(contexts.map((c) => c.close()));
});

test('spec 9.1: every Home opens with the welcome as its one h1 and has its tab title', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto(homeOf(fx));
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('h1')).toHaveText(/^Welcome back, .+\.$/);
  await expect(page).toHaveTitle(new RegExp(`^${HOME_COPY.titles.home} · `));
});

for (const role of ['owner', 'admin'] as const) {
  test(`spec 9.1: an ${role === 'owner' ? 'Owner' : 'Admin'} sees the overdue mitigations and the findings with no mitigation above the stages`, async ({ browser }) => {
    const page = await signedIn(browser, fx.members[role]);
    await page.goto(homeOf(fx));
    await expect(h2(page, HOME_COPY.assignedHeading)).toBeVisible();
    const [overdueTop, missingTop, stagesTop] = await Promise.all([
      h2(page, HOME_COPY.leadOverdueHeading).evaluate((el) => el.getBoundingClientRect().top),
      h2(page, HOME_COPY.leadNoMitigationHeading).evaluate((el) => el.getBoundingClientRect().top),
      page.getByText(HOME_COPY.stagesLead).evaluate((el) => el.getBoundingClientRect().top),
    ]);
    expect(overdueTop).toBeLessThan(stagesTop);
    expect(missingTop).toBeLessThan(stagesTop);
    // Exactly one "New project" for a role that may create (coordinator's ruling for the owner, 15 Nov 2026 22:20; O-13).
    await expect(page.getByText('New project', { exact: true })).toHaveCount(1);
  });
}

test('spec 9.1: an Assessor sees the next step, Assigned to you and the three stages; Continue recording opens the question', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto(homeOf(fx));
  const card = page.getByRole('region', { name: HOME_COPY.nextStepHeading });
  await expect(card).toBeVisible();
  await expect(h2(page, HOME_COPY.assignedHeading)).toBeVisible();
  for (const stage of ['Pre-processing', 'In-processing', 'Post-processing']) await expect(page.getByRole('heading', { level: 3, name: stage })).toBeVisible();
  await expect(page.getByText(HOME_COPY.leadOverdueHeading)).toHaveCount(0);
  const code = (await card.locator('.home-next__code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^Q-PP-/);
  await card.getByRole('link', { name: HOME_COPY.continueRecording }).click();
  await page.waitForURL(`**/stages/pre-processing/questions/${code}`);
});

test('spec 9.1: a Reviewer sees the three lists and no next step', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.reviewer);
  await page.goto(homeOf(fx));
  for (const name of [HOME_COPY.reviewerUnsealed, HOME_COPY.reviewerChanged, HOME_COPY.reviewerRaised]) await expect(h2(page, name)).toBeVisible();
  await expect(page.getByText(HOME_COPY.nextStepHeading)).toHaveCount(0);
  await expect(page.getByRole('link', { name: HOME_COPY.continueRecording })).toHaveCount(0);
});

test('spec 9.1: a Viewer sees what was recorded in the last 14 days and what is still open, and no next step', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.viewer);
  await page.goto(homeOf(fx));
  await expect(h2(page, HOME_COPY.viewerRecent)).toBeVisible();
  await expect(h2(page, HOME_COPY.viewerOpen)).toBeVisible();
  await expect(page.getByText(HOME_COPY.nextStepHeading)).toHaveCount(0);
  await expect(page.getByRole('link', { name: HOME_COPY.continueRecording })).toHaveCount(0);
});

test('spec 9.1, M13: a new organisation shows the first visit: Create a project for an Owner, the ask line for a Viewer', async ({ browser }) => {
  const owner = await signedIn(browser, fresh.members.owner);
  await owner.goto(homeOf(fresh));
  await expect(owner.getByText(HOME_COPY.firstTimeLead)).toBeVisible();
  await owner.getByRole('link', { name: HOME_COPY.firstTimeCreate }).click();
  await owner.waitForURL(`**/orgs/${fresh.org.slug}/projects/new`);
  const viewer = await signedIn(browser, fresh.members.viewer);
  await viewer.goto(homeOf(fresh));
  await expect(viewer.getByText(HOME_COPY.firstTimeAsk)).toBeVisible();
  await expect(viewer.getByRole('link', { name: HOME_COPY.firstTimeCreate })).toHaveCount(0);
});

test('owner ruling (15 Nov): an Assessor who has never saved sees Start recording, which opens the first question', async ({ browser }) => {
  const page = await signedIn(browser, starting.members.assessor);
  await page.goto(homeOf(starting));
  const card = page.getByRole('region', { name: HOME_COPY.nextStepHeading });
  await expect(card.getByRole('link', { name: HOME_COPY.continueRecording })).toHaveCount(0);
  await card.getByRole('link', { name: PROJECT_COPY.start }).click();
  await page.waitForURL('**/stages/pre-processing/questions/*');
});

test('NFR-A11Y-02 (code review M8): keyboard only, an Assessor reaches the project from Home and opens it', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto(homeOf(fx));
  const target = LONG_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let i = 0; ; i += 1) {
    if (i === 80) throw new Error('no focus stop reached the project name in 80 presses');
    await page.keyboard.press('Tab');
    const name = await page.evaluate(() => (document.activeElement?.textContent ?? '').trim());
    if (new RegExp(`^${target}$`).test(name)) break;
  }
  await page.keyboard.press('Enter');
  await page.waitForURL(`**/orgs/${fx.org.slug}/projects/${project.id}`);
});

for (const role of ['owner', 'reviewer', 'viewer'] as const) {
  for (const width of [1280, 375, 320]) {
    for (const theme of ['light', 'dark'] as const) {
      test(`NFR-A11Y-05 UX-32: Home as ${role} at ${width}px, ${theme}: no serious violation, no horizontal scroll`, async ({ browser }) => {
        const page = await signedIn(browser, fx.members[role]);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(homeOf(fx));
        await expect(page.locator('h1')).toBeVisible();
        await expectNoSeriousA11yViolations(page, `Home ${role} ${width} ${theme}`);
        await expectNoHorizontalScroll(page);
      });
    }
  }
}
