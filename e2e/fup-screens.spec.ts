import 'dotenv/config';
import { execSync } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { addFinding, addMitigationVersion, addProject, buildOrg, type FixtureAccount, type OrgFixture } from '../__tests__/helpers/recordFixture';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { pendingTargetFor } from './helpers/pendingLinks';
import { eatDate } from '../lib/followup/overdue';

/**
 * The follow-up lines of S-10 and the reminder setting of S-21 in a browser (FR-FUP-01, FR-FUP-06,
 * NFR-A11Y-02, NFR-A11Y-05). The screens belong to PRJ (S-10) and ACC-b (S-21): FUP delivers their slot
 * components. A case skips only while its page has not been wired: S-21 while `/account` is in
 * PENDING_LINK_TARGETS, S-10 while no file under app/ imports StageFollowUp. Never on what the page shows, so
 * once the page lands a broken slot fails the case. Accounts are made per case with K0a's buildOrg, as e2e/acceptances.spec.ts does.
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

/** Tab until the focused control is named `name` (an `aria-label`, its `<label>`, or its text); `inside` limits it to a container. */
async function tabUntil(page: Page, name: RegExp, opts: { inside?: string; max?: number } = {}): Promise<void> {
  const max = opts.max ?? 80;
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    const found = await page.evaluate(({ inside }) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      if (inside && !el.closest(inside)) return null;
      const labelled = (el as HTMLInputElement).labels?.[0]?.textContent;
      return (el.getAttribute('aria-label') ?? labelled ?? el.textContent ?? '').trim();
    }, { inside: opts.inside });
    if (found !== null && name.test(found)) return;
  }
  throw new Error(`tabUntil: no focus stop matched ${name} in ${max} presses`);
}

const FOLLOW_UP = 'section[aria-labelledby^="follow-up-"]';

/** True while no page under app/ renders the S-10 slot (PRJ has not wired it). */
function slotNotWired(component: string): boolean {
  return execSync(`git grep -l -F "components/followup/${component}'" -- app || true`, { encoding: 'utf8' }).trim() === '';
}

async function openProject(page: Page, path: string): Promise<void> {
  test.skip(slotNotWired('StageFollowUp'), 'no page under app/ imports StageFollowUp yet (PRJ, S-10)');
  await page.goto(path);
}

test('NFR-A11Y-02 FR-FUP-01: keyboard only, a member reaches an overdue mitigation from S-10 and opens S-15', async ({ browser }) => {
  const { fx, path } = await projectWithFollowUp();
  const page = await signedIn(browser, fx.members.owner);
  await openProject(page, path);
  await tabUntil(page, /^Open$/, { inside: FOLLOW_UP }); await expectFocusVisibleAndUncovered(page);
  await page.keyboard.press('Enter'); await expect(page).toHaveURL(/\/findings\//);
});

for (const width of [1280, 360, 320]) for (const theme of ['light', 'dark'] as const)
  test(`NFR-A11Y-05: the follow-up lines on S-10 at ${width}px, ${theme}: no serious violation; overdue said in words`, async ({ browser }) => {
    const { fx, path } = await projectWithFollowUp();
    const page = await signedIn(browser, fx.members.owner);
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: theme });
    await openProject(page, path);
    await expectNoSeriousA11yViolations(page, `S-10 follow-up ${width} ${theme}`);
    await expect(page.getByText(/^Overdue: was due \d{1,2} [A-Z][a-z]{2} \d{4}$/).first()).toBeVisible();
  });

test('NFR-A11Y-02 FR-FUP-06: the reminder setting on S-21 toggles by keyboard and announces "Reminder emails turned off."', async ({ browser }) => {
  const fx = await buildOrg({ label: 'fups' });
  const page = await signedIn(browser, fx.members.assessor);
  test.skip(pendingTargetFor('/account') !== undefined, '/account is in PENDING_LINK_TARGETS (ACC-b, S-21)');
  await page.goto('/account');
  await tabUntil(page, /Email me when a mitigation I own is due/);
  await page.keyboard.press('Space'); await expect(page.getByRole('status').filter({ hasText: 'Reminder emails' })).toHaveText('Reminder emails turned off.');   // 7.4.2 row S-21
  await page.keyboard.press('Space'); await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toHaveText('Saved.');
});
