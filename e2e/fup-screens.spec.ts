import 'dotenv/config';
import { test, expect, type Page } from '@playwright/test';
import { addFinding, addMitigationVersion, addProject, buildOrg, type FixtureAccount, type OrgFixture } from '../__tests__/helpers/recordFixture';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { eatDate } from '../lib/followup/overdue';

/**
 * The follow-up lines of S-10 and the reminder setting of S-21 in a browser (FR-FUP-01, FR-FUP-06,
 * NFR-A11Y-02, NFR-A11Y-05). The screens belong to PRJ (S-10) and ACC-b (S-21): FUP delivers their slot
 * components, so each case skips, with its reason, while the page that renders the slot is not on the
 * branch. Accounts are made per case with K0a's buildOrg, as e2e/acceptances.spec.ts does.
 */

let ipSeq = 0;
const nextClientIp = () => `10.77.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
const DAY_MS = 24 * 3600 * 1000;

async function signedIn(browser: import('@playwright/test').Browser, account: Pick<FixtureAccount, 'email' | 'password'>): Promise<Page> {
  const page = await (await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': nextClientIp() } })).newPage();
  await page.goto('/login');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
  return page;
}

/** An organisation whose project holds one overdue and one later mitigation, both owned by the assessor. */
async function projectWithFollowUp(): Promise<{ fx: OrgFixture; path: string }> {
  const fx = await buildOrg({ label: 'fup' });
  const p = await addProject(fx);
  const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
  const day = (offset: number) => eatDate(new Date(Date.now() + offset * DAY_MS));
  await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: day(-3) });
  await addMitigationVersion(fx, f.id, { status: 'in_progress', owner: 'assessor', dueDate: day(10) });
  return { fx, path: `/orgs/${fx.org.slug}/projects/${p.id}` };
}

async function tabUntil(page: Page, name: RegExp, max = 80): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? (el.getAttribute('aria-label') ?? el.textContent ?? '').trim() : '';
    });
    if (name.test(label)) return;
  }
  throw new Error(`tabUntil: no focus stop matched ${name} in ${max} presses`);
}

async function skipWithoutFollowUp(page: Page, path: string): Promise<void> {
  await page.goto(path);
  test.skip(await page.getByText('Mitigations to follow up').count() === 0, 'S-10 does not render StageFollowUp yet (PRJ)');
}

test('NFR-A11Y-02 FR-FUP-01: keyboard only, a member reaches an overdue mitigation from S-10 and opens S-15', async ({ browser }) => {
  const { fx, path } = await projectWithFollowUp();
  const page = await signedIn(browser, fx.members.owner);
  await skipWithoutFollowUp(page, path);
  await tabUntil(page, /^Open$/); await expectFocusVisibleAndUncovered(page);
  await page.keyboard.press('Enter'); await expect(page).toHaveURL(/\/findings\//);
});

for (const width of [1280, 360, 320]) for (const theme of ['light', 'dark'] as const)
  test(`NFR-A11Y-05: the follow-up lines on S-10 at ${width}px, ${theme}: no serious violation; overdue said in words`, async ({ browser }) => {
    const { fx, path } = await projectWithFollowUp();
    const page = await signedIn(browser, fx.members.owner);
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: theme });
    await skipWithoutFollowUp(page, path);
    await expectNoSeriousA11yViolations(page, `S-10 follow-up ${width} ${theme}`);
    await expect(page.getByText(/^Overdue: was due \d{1,2} [A-Z][a-z]{2} \d{4}$/).first()).toBeVisible();
  });

test('NFR-A11Y-02 FR-FUP-06: the reminder setting on S-21 toggles by keyboard and announces "Reminder emails turned off."', async ({ browser }) => {
  const fx = await buildOrg({ label: 'fups' });
  const page = await signedIn(browser, fx.members.assessor);
  await page.goto('/account');
  test.skip(await page.getByText('Email me when a mitigation I own is due').count() === 0, 'S-21 not yet on the branch (ACC-b)');
  await tabUntil(page, /Email me when a mitigation I own is due/);
  await page.keyboard.press('Space'); await expect(page.getByRole('status').filter({ hasText: 'Reminder emails' })).toHaveText('Reminder emails turned off.');   // 7.4.2 row S-21
  await page.keyboard.press('Space'); await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toHaveText('Saved.');
});
