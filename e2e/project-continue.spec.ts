import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { addProject, buildOrg, type FixtureAccount, type OrgFixture } from '../__tests__/helpers/recordFixture';
import { questionsInStage, runningContent } from '../lib/content/loader';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { PROJECT_COPY } from '../lib/project/copy';
import { closeOpenedContexts } from './helpers/contexts';

// Every context a test opened is closed after it (helpers/contexts.ts says why).
test.afterEach(closeOpenedContexts);

/**
 * The project page's one primary action in a browser (plan 1C C11, cut; spec 9.2): an Assessor on a fresh project sees
 * "Start recording", which opens the first question of Pre-processing; after a saved decision the page says "Continue
 * recording" and opens the next question with no decision, the one Home's card names; a Reviewer and a Viewer see neither
 * label, and an archived project shows neither; no serious axe violation and no sideways scroll at 1280, 375 and 320 px.
 * The organisation is this spec's own (record fixture builder); each case signs in on the login page.
 */
let fx: OrgFixture;
let project: { id: string };
let archived: { id: string };
let ipSeq = 0;
const nextClientIp = () => `10.81.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

async function signedIn(browser: Browser, account: Pick<FixtureAccount, 'email' | 'password'>): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': nextClientIp() } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
  return page;
}

const projectPage = (id: string) => `/orgs/${fx.org.slug}/projects/${id}`;
const primary = (page: Page, name: string) => page.getByRole('link', { name, exact: true });
/** A stage's own link to its first question with no decision (G4): "Next: Question N · Continue", or "· View" for a role that cannot record. */
const nextLink = (page: Page, stage: string, label: 'Continue' | 'View') => page.locator(`#${stage}`).getByRole('link', { name: new RegExp(`^Next: Question \\d+ · ${label}$`) });
const REPORT = PROJECT_COPY.overview.openReport;
const PP_FIRST = questionsInStage(runningContent(), 'pre-processing')[0].id;
const IP = questionsInStage(runningContent(), 'in-processing').map((q) => q.id);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fx = await buildOrg({ label: 'cont' });
  project = await addProject(fx, { name: `Continue ${randomUUID().slice(0, 8)}` });
  archived = await addProject(fx, { name: `Archived ${randomUUID().slice(0, 8)}`, archived: true });
});

test('C11 G5: an assessor on a fresh project sees the stage link Next: Question 1 · Continue, which opens the first question of Pre-processing', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto(projectPage(project.id));
  // G5 (supersedes C3): the one primary is the working report; recording starts from the stage's own link.
  await expect(page.locator('main .ui-button--primary')).toHaveText(REPORT);
  await expect(page.getByText(PROJECT_COPY.start)).toHaveCount(0);
  await nextLink(page, 'pre-processing', 'Continue').click();
  await page.waitForURL(`**/stages/pre-processing/questions/${PP_FIRST}`);
  // The question page's heading is the question in words; its code is the line under it (the frame of slice 1).
  await expect(page.locator('.question-frame__code')).toContainText(PP_FIRST);
});

test('C11 G5 I1: after a saved decision, the in-processing stage link opens the question Home names', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  const res = await page.context().request.post(`/api/v1/orgs/${fx.org.slug}/projects/${project.id}/decisions`, {
    headers: { origin: new URL(page.url()).origin },
    data: {
      requestId: randomUUID(), stage: 'in-processing', questionId: IP[1], baseVersionNumber: null, status: 'done', scopeAnswer: null,
      optionsInPlace: [], reasonCode: null, reason: `Seeded reason ${randomUUID()} for this decision.`,
      decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, declaredDate: '2026-10-30', evidenceIds: [],
    },
  });
  if (!res.ok()) throw new Error(`seeding ${IP[1]} answered ${res.status()}: ${await res.text()}`);
  // I1 (controller ruling): in the stage that holds Home's continue target, the stage link names that question, the one Home names.
  await page.goto(`/orgs/${fx.org.slug}/dashboard`);
  const homeCode = (await page.locator('.home-next__code').textContent())?.trim() ?? '';
  expect(homeCode).toBe(IP[2]);
  await page.goto(projectPage(project.id));
  await expect(page.locator('main .ui-button--primary')).toHaveText(REPORT);
  await expect(nextLink(page, 'in-processing', 'Continue')).toHaveText(`Next: Question ${IP.indexOf(homeCode) + 1} · Continue`);
  // Another stage keeps its first open question.
  await expect(nextLink(page, 'pre-processing', 'Continue')).toHaveAttribute('href', new RegExp(`/questions/${PP_FIRST}$`));
  await nextLink(page, 'in-processing', 'Continue').click();
  await page.waitForURL(`**/stages/in-processing/questions/${homeCode}`);
  await expect(page.locator('.question-frame__code')).toContainText(homeCode);
});

for (const role of ['reviewer', 'viewer'] as const) {
  test(`C11 O1: a ${role} sees the stage links as Next: Question N · View, never Continue, and the report as the one primary`, async ({ browser }) => {
    const page = await signedIn(browser, fx.members[role]);
    await page.goto(projectPage(project.id));
    await expect(page.locator('nav.project-actions').getByRole('link', { name: PROJECT_COPY.findings, exact: true })).toBeVisible();   // the page rendered, the role's own row
    await expect(page.getByText(PROJECT_COPY.start)).toHaveCount(0);
    await expect(page.getByText(PROJECT_COPY.continue)).toHaveCount(0);
    await expect(page.getByText(/· Continue$/)).toHaveCount(0);
    await expect(nextLink(page, 'pre-processing', 'View')).toHaveCount(1);
    await expect(page.locator('main .ui-button--primary')).toHaveText(REPORT);
  });
}

test('C11 O1: an archived project shows View links and no Continue, to its owner', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner);
  await page.goto(projectPage(archived.id));
  await expect(page.getByText(PROJECT_COPY.archivedBanner)).toBeVisible();
  await expect(page.getByText(PROJECT_COPY.start)).toHaveCount(0);
  await expect(page.getByText(PROJECT_COPY.continue)).toHaveCount(0);
  await expect(page.getByText(/· Continue$/)).toHaveCount(0);
  await expect(nextLink(page, 'pre-processing', 'View')).toHaveCount(1);
});

for (const width of [1280, 375, 320]) {
  test(`NFR-A11Y-05 UX-32: the project page with the report primary and the stage bars at ${width}px: no serious violation, no horizontal scroll`, async ({ browser }) => {
    const page = await signedIn(browser, fx.members.owner);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(projectPage(project.id));
    await expect(primary(page, REPORT)).toBeVisible();
    await expectNoSeriousA11yViolations(page, `Project page primary ${width}`);
    await expectNoHorizontalScroll(page);
  });
}
