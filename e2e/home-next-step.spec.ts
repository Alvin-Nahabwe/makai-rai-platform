import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { addProject, buildOrg, type FixtureAccount, type OrgFixture } from '../__tests__/helpers/recordFixture';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { HOME_COPY } from '../lib/home/copy';

/**
 * Home's "Your next step" in a browser (plan 1B Task 10, slice 3 cut; spec 9.1): an Assessor who saved a decision sees the
 * section, "Continue recording" opens the question it names and "Choose another question" that stage's questions; a
 * Viewer sees no next step; no serious axe violation and no sideways scroll at 1280, 375 and 320 px in both themes, with
 * a 70-character project name. The organisation is this spec's own (record fixture builder); each case signs in on the
 * login page, as e2e/prj-screens.spec.ts does.
 */
const RUN = randomUUID().slice(0, 8);
// 70 characters, one long word among them, so the card must wrap it.
const LONG_NAME = `Next-step ${RUN} Antenatal-risk-triage-for-district-hospitals project`.padEnd(70, 'x').slice(0, 70);

let fx: OrgFixture;
let project: { id: string };
const contexts: BrowserContext[] = [];
let ipSeq = 0;
const nextClientIp = () => `10.79.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

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

const home = () => `/orgs/${fx.org.slug}/dashboard`;
const section = (page: Page) => page.getByRole('region', { name: HOME_COPY.nextStepHeading });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  fx = await buildOrg({ label: 'next' });
  project = await addProject(fx, { name: LONG_NAME });
  // One decision saved by the assessor through the route, with the assessor's own session.
  const assessor = await signedIn(browser, fx.members.assessor);
  const res = await assessor.context().request.post(`/api/v1/orgs/${fx.org.slug}/projects/${project.id}/decisions`, {
    headers: { origin: new URL(assessor.url()).origin },
    data: {
      requestId: randomUUID(), stage: 'in-processing', questionId: 'Q-IP-02', baseVersionNumber: null, status: 'done', scopeAnswer: null,
      optionsInPlace: [], reasonCode: null, reason: `Seeded reason ${randomUUID()} for this decision.`,
      decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, declaredDate: '2026-10-30', evidenceIds: [],
    },
  });
  if (!res.ok()) throw new Error(`seeding Q-IP-02 answered ${res.status()}: ${await res.text()}`);
});

test.afterAll(async () => {
  await Promise.all(contexts.map((c) => c.close()));
});

test('spec 9.1: an assessor who saved sees the next step above Active projects; Continue recording opens the question it names', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto(home());
  const card = section(page);
  await expect(card).toBeVisible();
  await expect(card).toContainText(HOME_COPY.projectOf(LONG_NAME));
  await expect(card).toContainText('In-processing');
  // The section comes before Active projects.
  const [cardTop, activeTop] = await Promise.all([
    card.evaluate((el) => el.getBoundingClientRect().top),
    page.getByRole('heading', { name: HOME_COPY.activeProjects }).evaluate((el) => el.getBoundingClientRect().top),
  ]);
  expect(cardTop).toBeLessThan(activeTop);
  const code = (await card.locator('.next-step__code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^Q-IP-/);
  expect(code).not.toBe('Q-IP-02');   // the next question with no decision, not the saved one
  await card.getByRole('link', { name: HOME_COPY.continueRecording }).click();
  await page.waitForURL(`**/stages/in-processing/questions/${code}`);
  await expect(page.locator('#question-heading')).toContainText(code);
});

test('spec 9.1: Choose another question opens that stage\'s All questions', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto(home());
  await section(page).getByRole('link', { name: HOME_COPY.chooseAnother }).click();
  await page.waitForURL(`**/orgs/${fx.org.slug}/projects/${project.id}/stages/in-processing`);
  expect(new URL(page.url()).pathname).toBe(`/orgs/${fx.org.slug}/projects/${project.id}/stages/in-processing`);
});

test('T9.5: a viewer sees no next step and no Continue recording', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.viewer);
  await page.goto(home());
  await expect(page.getByRole('heading', { name: HOME_COPY.activeProjects })).toBeVisible();
  await expect(page.getByText(HOME_COPY.nextStepHeading)).toHaveCount(0);
  await expect(page.getByRole('link', { name: HOME_COPY.continueRecording })).toHaveCount(0);
});

for (const width of [1280, 375, 320]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`NFR-A11Y-05 UX-32: Home with the next step at ${width}px, ${theme}: no serious violation, no horizontal scroll`, async ({ browser }) => {
      const page = await signedIn(browser, fx.members.assessor);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(home());
      await expect(section(page)).toBeVisible();
      await expectNoSeriousA11yViolations(page, `Home next step ${width} ${theme}`);
      await expectNoHorizontalScroll(page);
    });
  }
}
