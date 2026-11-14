import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import { escapeRe } from '../__tests__/helpers/escapeRe';
import { buildOrg, type FixtureAccount, type OrgFixture } from '../__tests__/helpers/recordFixture';
import { claimMatches } from '../lib/claims/pattern';
import { currentLegalText } from '../lib/legal/registry';
import { acceptanceError } from '../lib/legal/kinds';
import { VALIDATION_COPY } from '../lib/http/copy';
import { ACCEPT_LABEL } from '../components/legal/AcceptancesForm';
import { INVITATION_COPY } from '../lib/invitations/copy';
import { ACCEPTANCES_COPY } from '../lib/legal/acceptances/copy';
import { INVITATION_PAGE_COPY, roleWithArticle } from '../lib/org/copy';
import { ACCEPTED_KINDS, CONSENT_TYPE_FOR } from '../types/legal';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { expectTargetsAtLeast24px } from './helpers/targetSize';

/**
 * J-03 and the acceptance gate in a browser (FR-ACC-01 to FR-ACC-04, UX-01, UX-22; SRS 3 J-03,
 * 7.1.2, W-11). What the vitest cases of S-04 and S-05 cannot do without a DOM (a click, a focus
 * move, a request that is not sent) is driven here against the real server, and the database is
 * read back with the owner role (counts only).
 *
 * Accounts are made per test with K0a's buildOrg; in this process fixtureLegalTexts() reads the
 * real registry, so a default buildOrg account passes the real gate. Each context signs in from
 * its own client address, as auth.setup.ts does, so the per-address sign-in limit is not shared.
 */

let ipSeq = 0;
const nextClientIp = () => `10.44.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': nextClientIp() } });
  return context.newPage();
}

async function signIn(page: Page, account: Pick<FixtureAccount, 'email' | 'password'>): Promise<void> {
  await page.goto('/login');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
}

async function invitationFor(fx: OrgFixture, email: string, role: 'assessor' | 'viewer') {
  const raw = randomBytes(32).toString('hex');
  await testDb.invitation.create({ data: {
    orgId: fx.org.id, email, role, tokenHash: createHash('sha256').update(raw).digest('hex'),
    invitedById: fx.members.owner.userId, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  } });
  return raw;
}

const userCount = (email: string) => testDb.user.count({ where: { email } });

/** Tab until `target` has focus, checking at each press that the focused element is visible and not covered (NFR-A11Y-02). */
async function tabTo(page: Page, target: ReturnType<Page['locator']>, max = 40): Promise<void> {
  // The page scrolls smoothly (app/globals.css), so a focus that needs a scroll is not in view for a moment; this check is of
  // where focus ends up, so the scroll is made instant (the probe: with 400 ms to settle the field was in view).
  await page.addStyleTag({ content: 'html { scroll-behavior: auto !important; }' });
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    await expectFocusVisibleAndUncovered(page);
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`tabTo: ${max} presses of Tab did not reach the target`);
}

/**
 * Records, at the moment each box receives focus, what a screen reader reads on arrival: the box's id, its
 * aria-invalid and the text of the elements its aria-describedby names. A web-first assertion made after the press
 * retries until it passes, so it cannot tell an error drawn before focus moved from one drawn just after; this can.
 */
async function recordFocusArrivals(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { focusArrivals: Array<{ id: string; invalid: string | null; description: string }> };
    w.focusArrivals = [];
    document.addEventListener('focusin', (e) => {
      const el = e.target as HTMLElement;
      if (!(el instanceof HTMLInputElement) || el.type !== 'checkbox') return;
      const description = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      w.focusArrivals.push({ id: el.id, invalid: el.getAttribute('aria-invalid'), description });
    });
  });
}

const focusArrivals = (page: Page) =>
  page.evaluate(() => (window as unknown as { focusArrivals: Array<{ id: string; invalid: string | null; description: string }> }).focusArrivals);

test.afterAll(async () => {
  await testDb.$disconnect();
});

test.describe('S-04 and S-05 in a browser', () => {
  test('FR-ACC-01 FR-ACC-03 J-03: a new person creates an account from an invitation and lands on the dashboard', async ({ browser }) => {
    const fx = await buildOrg({ label: 'jthree' });
    const email = `j03-${Date.now()}@fixture.test`;
    const raw = await invitationFor(fx, email, 'assessor');
    const page = await newPage(browser);
    const posts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/register')) posts.push(r.url()); });

    await page.goto(`/invitations/${raw}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(INVITATION_PAGE_COPY.heading(fx.org.name));
    await expect(page.getByText(new RegExp(`^${escapeRe(fx.members.owner.name)} ${escapeRe(INVITATION_PAGE_COPY.invitedAs(roleWithArticle('assessor')))}\\. This invitation ends on \\d{1,2} [A-Z][a-z]{2} \\d{4}\\.$`))).toBeVisible();
    await expect(page.getByLabel(/^Email/)).toHaveValue(email);

    // 7.4.2 S-04 validation: Continue with nothing typed stays on step 1 and names both fields.
    await page.getByRole('button', { name: INVITATION_COPY.continue }).click();
    await expect(page.getByLabel(INVITATION_COPY.name)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel(INVITATION_COPY.name)).toBeFocused();
    await expect(page.locator('#new-password')).toHaveAccessibleDescription(new RegExp(escapeRe(VALIDATION_COPY.passwordRequired)));

    await page.getByLabel(INVITATION_COPY.name).fill('Jay Three');
    await page.locator('#new-password').fill('J03-password-ok');
    await page.getByRole('button', { name: INVITATION_COPY.showPassword }).click();
    await expect(page.locator('#new-password')).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: INVITATION_COPY.continue }).click();
    // Step 1's form and its button are gone: focus moves to step 2, not to the page body (WCAG 2.4.3).
    await expect(page.locator('#acceptances-step')).toBeFocused();

    // UX-22: three unticked boxes, each link says it opens a new tab.
    await expect(page.getByRole('checkbox')).toHaveCount(3);
    for (const box of await page.getByRole('checkbox').all()) await expect(box).not.toBeChecked();
    await expect(page.getByRole('link', { name: /\(opens in a new tab\)$/ })).toHaveCount(3);

    // Two ticks: M-25 names the third, focus moves to it, and nothing is sent.
    await page.getByLabel(ACCEPT_LABEL.terms, { exact: true }).check();
    await page.getByLabel(ACCEPT_LABEL.privacy, { exact: true }).check();
    await recordFocusArrivals(page);
    await page.getByRole('button', { name: INVITATION_COPY.createAccount }).click();
    // Focus lands on the unticked box with its error already drawn (R1-1): invalid, and the error in its description.
    const thirdBox = page.getByLabel(ACCEPT_LABEL['cross-border-consent'], { exact: true });
    await expect(thirdBox).toBeFocused();
    await expect(thirdBox).toHaveAttribute('aria-invalid', 'true');
    await expect(thirdBox).toHaveAccessibleDescription(new RegExp(escapeRe(ACCEPTANCES_COPY.tickThis)));
    expect(await focusArrivals(page)).toEqual([
      { id: 'accept-cross-border-consent', invalid: 'true', description: expect.stringContaining(ACCEPTANCES_COPY.tickThis) },
    ]);
    // The kit's error summary lists the missing box as a link to it; the box carries its own short error.
    const summary = page.locator('.ui-error-summary');
    await expect(summary.getByRole('heading')).toHaveText(ACCEPTANCES_COPY.summaryTitle);
    await expect(summary.getByRole('link')).toHaveText(acceptanceError('cross-border-consent'));
    await expect(page.locator('#accept-cross-border-consent-error')).toHaveText(ACCEPTANCES_COPY.tickThis);
    await expect(page.getByLabel(ACCEPT_LABEL['cross-border-consent'], { exact: true })).toBeFocused();
    await expect(page.getByLabel(ACCEPT_LABEL['cross-border-consent'], { exact: true })).toHaveAttribute('aria-invalid', 'true');
    expect(posts).toEqual([]);
    expect(await userCount(email)).toBe(0);

    await page.getByLabel(ACCEPT_LABEL['cross-border-consent'], { exact: true }).check();
    await page.getByRole('button', { name: INVITATION_COPY.createAccount }).click();
    await page.waitForURL(`**/orgs/${fx.org.slug}/dashboard?welcome=1`);
    expect(new URL(page.url()).search).toBe('?welcome=1');
    const user = await testDb.user.findUniqueOrThrow({ where: { email } });
    expect(await testDb.consentRecord.count({ where: { userId: user.id } })).toBe(3);
    expect(await testDb.membership.findMany({ where: { userId: user.id }, select: { orgId: true, role: true } }))
      .toEqual([{ orgId: fx.org.id, role: 'assessor' }]);

    // The same link again: M-23 and nothing else.
    await page.goto(`/invitations/${raw}`);
    await expect(page.getByText(INVITATION_PAGE_COPY.unusable)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(INVITATION_PAGE_COPY.unusableHeading);
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await page.context().close();
  });

  test('FR-ACC-04 UX-01: an account with only pre-v1 rows reaches only S-05, S-06 and S-21, then the dashboard after accepting', async ({ browser }) => {
    const fx = await buildOrg({ label: 'prevone', acceptances: 'pre-v1' });
    const page = await newPage(browser);
    await signIn(page, fx.members.assessor);
    await page.goto(`/orgs/${fx.org.slug}/dashboard`);
    await expect(page).toHaveURL(/\/acceptances$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/acceptances$/);
    expect((await page.goto('/legal/terms'))?.status()).toBe(200);

    // C4 CR-1 / SE-1: a click in the rail is a client-side navigation, which does not re-render the
    // shared (authenticated) layout; each destination must still send the account back to S-05.
    const nav = page.getByRole('navigation', { name: 'Main', exact: true });
    // Every link of the shell's rail, by href (several org items fall back to / outside an organisation). A public page
    // (PUB's /about, Help, a legal text) is open to anyone, and gate 3 lets S-21 through (My account: export and
    // deletion, FR-ACC-04), so a click on one of those lands there. Asserting "back on S-05" for them passed only while
    // the assertion ran before the router had shown the page, and failed when the page won (seen on a production build).
    await page.goto('/acceptances');
    await expect(nav).toBeVisible();
    const hrefs = [...new Set(await nav.getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? '')))];
    expect(hrefs, 'the rail has links to try').toEqual(expect.arrayContaining(['/explore/framework', '/account']));
    // Guidance is the rail's one entry to the framework pages; Controls is reached from it, not from the rail.
    expect(hrefs).not.toContain('/explore/controls');
    const REACHABLE = /^\/(about$|help$|legal\/|account$)/;
    for (const href of hrefs) {
      await page.goto('/acceptances');
      // The router's own request for the destination (not a prefetch), so the check waits for the server's answer.
      const answered = page.waitForResponse((r) => new URL(r.url()).pathname === href && r.request().headers()['rsc'] === '1'
        && r.request().headers()['next-router-prefetch'] === undefined);
      await nav.locator(`a[href="${href}"]`).first().click();
      await answered;
      if (REACHABLE.test(href)) {
        await expect(page, href).toHaveURL(new RegExp(`${href}$`));
        continue;
      }
      await expect(page, href).toHaveURL(/\/acceptances$/);
      await expect(page.getByRole('heading', { level: 1 }), href).toHaveText(ACCEPTANCES_COPY.legend);
    }

    // S-05: one box unticked sends nothing and moves focus to it.
    const posts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/acceptances')) posts.push(r.url()); });
    await page.goto('/acceptances');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(ACCEPTANCES_COPY.legend);
    await expect(page.getByRole('link', { name: /\(opens in a new tab\)$/ })).toHaveCount(3);
    await page.getByLabel(ACCEPT_LABEL.terms, { exact: true }).check();
    await recordFocusArrivals(page);
    await page.getByRole('button', { name: ACCEPTANCES_COPY.submit }).click();
    const summary = page.locator('.ui-error-summary');
    await expect(summary).toContainText(acceptanceError('privacy'));
    await expect(summary).toContainText(acceptanceError('cross-border-consent'));
    // Focus lands on the first unticked box with its error already drawn (R1-1): invalid, and the error in its description.
    const firstUnticked = page.getByLabel(ACCEPT_LABEL.privacy, { exact: true });
    await expect(firstUnticked).toBeFocused();
    await expect(firstUnticked).toHaveAttribute('aria-invalid', 'true');
    await expect(firstUnticked).toHaveAccessibleDescription(new RegExp(escapeRe(ACCEPTANCES_COPY.tickThis)));
    expect(await focusArrivals(page)).toEqual([
      { id: 'accept-privacy', invalid: 'true', description: expect.stringContaining(ACCEPTANCES_COPY.tickThis) },
    ]);
    expect(posts).toEqual([]);

    await page.getByLabel(ACCEPT_LABEL.privacy, { exact: true }).check();
    await page.getByLabel(ACCEPT_LABEL['cross-border-consent'], { exact: true }).check();
    await page.getByRole('button', { name: ACCEPTANCES_COPY.submit }).click();
    await page.waitForURL((url) => url.pathname !== '/acceptances');
    expect(posts).toHaveLength(1);
    const res = await page.goto(`/orgs/${fx.org.slug}/dashboard`);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/orgs/${fx.org.slug}/dashboard$`));
    await page.context().close();
  });

  test('FR-ACC-04 UX-01 (ruling after S4): a person held at gate 3 has no organisation link in the rail on S-05 and S-21, and has them once the texts are accepted', async ({ browser }) => {
    const fx = await buildOrg({ label: 'heldrail', acceptances: 'pre-v1' });
    const page = await newPage(browser);
    await signIn(page, fx.members.assessor);
    const nav = page.getByRole('navigation', { name: 'Main', exact: true });
    // As for a person in no organisation: Guidance, Help and My account, and nothing that names the organisation.
    for (const path of ['/acceptances', '/account']) {
      await page.goto(path);
      await expect(nav, path).toBeVisible();
      expect(await nav.getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('href'))), path)
        .toEqual(['/explore/framework', '/help', '/account']);
      await expect(nav, path).not.toContainText(fx.org.name);
    }
    // Accepting moves on by a client-side navigation to /, which sends a person whose last organisation is known straight to
    // its dashboard; the shared signed-in layout must then give the rail that organisation without a reload.
    await testDb.user.update({ where: { id: fx.members.assessor.userId }, data: { lastActiveOrgId: fx.org.id } });
    await page.goto('/acceptances');
    for (const box of await page.getByRole('checkbox').all()) await box.check();
    await page.getByRole('button', { name: ACCEPTANCES_COPY.submit }).click();
    await page.waitForURL((u) => u.pathname === `/orgs/${fx.org.slug}/dashboard`);
    await expect(nav.locator(`a[href="/orgs/${fx.org.slug}/dashboard"]`)).toHaveCount(1);
    await expect(nav.locator(`a[href="/orgs/${fx.org.slug}/projects"]`)).toHaveCount(1);
    await page.context().close();
  });

  test('SRS 7.1.2 gate 2 (ruling after S4): with a password change due, the rail on S-29 has no organisation link', async ({ browser }) => {
    const fx = await buildOrg({ label: 'heldpw' });
    const page = await newPage(browser);
    await signIn(page, fx.members.assessor);
    await testDb.user.update({ where: { id: fx.members.assessor.userId }, data: { mustChangePassword: true } });
    try {
      await page.goto('/change-password');
      const nav = page.getByRole('navigation', { name: 'Main', exact: true });
      await expect(nav).toBeVisible();
      expect(await nav.getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('href'))))
        .toEqual(['/explore/framework', '/help', '/account']);
      await expect(nav).not.toContainText(fx.org.name);
    } finally {
      await testDb.user.update({ where: { id: fx.members.assessor.userId }, data: { mustChangePassword: false } });
      await page.context().close();
    }
  });

  test('FR-ACC-01 (7.4.2 S-04): a lost connection on Create account says the account may already be created, and Try again sends the same body', async ({ browser }) => {
    const fx = await buildOrg({ label: 'resend' });
    const email = `resend-${Date.now()}@fixture.test`;
    const raw = await invitationFor(fx, email, 'viewer');
    const page = await newPage(browser);
    const bodies: string[] = [];
    await page.route('**/api/v1/invitations/*/register', async (route) => {
      bodies.push(route.request().postData() ?? '');
      // The first send gets no reply, as when the connection drops; the second goes through.
      if (bodies.length === 1) await route.abort('connectionfailed');
      else await route.continue();
    });
    await page.goto(`/invitations/${raw}`);
    await page.getByLabel(INVITATION_COPY.name).fill('Re Send');
    await page.locator('#new-password').fill('Resend-password-ok');
    await page.getByRole('button', { name: INVITATION_COPY.continue }).click();
    for (const box of await page.getByRole('checkbox').all()) await box.check();
    await page.getByRole('button', { name: INVITATION_COPY.createAccount }).click();
    const lost = page.getByRole('alert').filter({ hasText: ACCEPTANCES_COPY.send.account.lost });
    await expect(lost).toHaveText(ACCEPTANCES_COPY.send.account.lost);
    expect(await userCount(email)).toBe(0);
    await page.getByRole('button', { name: ACCEPTANCES_COPY.tryAgain }).click();   // the button follows the alert, outside it
    await page.waitForURL(`**/orgs/${fx.org.slug}/dashboard?welcome=1`);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(await userCount(email)).toBe(1);
    await page.context().close();
  });

  test('FR-ACC-01 (7.4.2 S-04): when the reply to Create account is lost after the account was created, the screen says it may exist, Try again shows M-23, and the person signs in with the password typed', async ({ browser }) => {
    const fx = await buildOrg({ label: 'lostreply' });
    const email = `lostreply-${Date.now()}@fixture.test`;
    const password = 'Lost-reply-password-ok';
    const raw = await invitationFor(fx, email, 'viewer');
    const page = await newPage(browser);
    const statuses: number[] = [];
    await page.route('**/api/v1/invitations/*/register', async (route) => {
      if (statuses.length === 0) {
        // The request reaches the server, which commits the account; its reply is then dropped, as when the connection fails on the way back.
        const reply = await route.fetch();
        statuses.push(reply.status());
        await route.abort('connectionfailed');
      } else {
        const reply = await route.fetch();
        statuses.push(reply.status());
        await route.fulfill({ response: reply });
      }
    });
    await page.goto(`/invitations/${raw}`);
    await page.getByLabel(INVITATION_COPY.name).fill('Lost Reply');
    await page.locator('#new-password').fill(password);
    await page.getByRole('button', { name: INVITATION_COPY.continue }).click();
    for (const box of await page.getByRole('checkbox').all()) await box.check();
    await page.getByRole('button', { name: INVITATION_COPY.createAccount }).click();
    const lost = page.getByRole('alert').filter({ hasText: ACCEPTANCES_COPY.send.account.lost });
    await expect(lost).toHaveText(ACCEPTANCES_COPY.send.account.lost);
    expect(statuses).toEqual([201]);
    expect(await userCount(email)).toBe(1);

    // Try again: the link is used now, so route 31 answers 410 and the screen shows M-23.
    await page.getByRole('button', { name: ACCEPTANCES_COPY.tryAgain }).click();
    await expect(page.getByRole('alert').filter({ hasText: INVITATION_PAGE_COPY.unusable })).toHaveText(INVITATION_PAGE_COPY.unusable);
    expect(statuses).toEqual([201, 410]);

    // Sign in with the invited email and the password typed in step 1: the person lands signed in.
    await signIn(page, { email, password });
    expect(new URL(page.url()).pathname).not.toBe('/login');
    const res = await page.goto(`/orgs/${fx.org.slug}/dashboard`);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/orgs/${escapeRe(fx.org.slug)}/dashboard$`));
    await page.context().close();
  });

  test('FR-ACC-04 (7.4.2 S-05): a lost connection on Accept and continue says the choice was not saved, and Try again sends the same body', async ({ browser }) => {
    const fx = await buildOrg({ label: 'resendfive', acceptances: 'pre-v1' });
    const page = await newPage(browser);
    await signIn(page, fx.members.assessor);
    const bodies: string[] = [];
    await page.route('**/api/acceptances', async (route) => {
      bodies.push(route.request().postData() ?? '');
      if (bodies.length === 1) await route.abort('connectionfailed');
      else await route.continue();
    });
    await page.goto('/acceptances');
    for (const box of await page.getByRole('checkbox').all()) await box.check();
    await page.getByRole('button', { name: ACCEPTANCES_COPY.submit }).click();
    const lost = page.getByRole('alert').filter({ hasText: ACCEPTANCES_COPY.send.choice.lost });
    await expect(lost).toHaveText(ACCEPTANCES_COPY.send.choice.lost);   // S-05 says what was being sent: a choice, not an account
    await page.getByRole('button', { name: ACCEPTANCES_COPY.tryAgain }).click();
    await page.waitForURL((url) => url.pathname !== '/acceptances');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(await testDb.consentRecord.count({ where: { userId: fx.members.assessor.userId, OR: ACCEPTED_KINDS.map((k) => ({ consentType: CONSENT_TYPE_FOR[k], version: currentLegalText(k).version })) } })).toBe(3);
    await page.context().close();
  });

  test('FR-ACC-03 (7.4.2 S-04): signed in without the acceptances, Try again after a lost send repeats the acceptances, then joins', async ({ browser }) => {
    // C4 CR-4: Try again repeats the last action (route 30's body), not the join (route 32).
    const host = await buildOrg({ label: 'retryhost' });
    const invitee = (await buildOrg({ label: 'retryinv', acceptances: 'pre-v1' })).members.viewer;
    const raw = await invitationFor(host, invitee.email, 'viewer');
    const page = await newPage(browser);
    await signIn(page, invitee);
    const posts: string[] = [];
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (r.method() === 'POST' && (path === '/api/acceptances' || path.startsWith('/api/v1/invitations/'))) posts.push(path);
    });
    const bodies: string[] = [];
    await page.route('**/api/acceptances', async (route) => {
      bodies.push(route.request().postData() ?? '');
      if (bodies.length === 1) await route.abort('connectionfailed');
      else await route.continue();
    });
    await page.goto(`/invitations/${raw}`);
    await page.getByRole('button', { name: INVITATION_COPY.accept }).click();
    await expect(page.locator('#acceptances-step')).toBeFocused();
    for (const box of await page.getByRole('checkbox').all()) await box.check();
    await page.getByRole('button', { name: ACCEPTANCES_COPY.submit }).click();
    const lost = page.getByRole('alert').filter({ hasText: ACCEPTANCES_COPY.send.choice.lost });
    await expect(lost).toHaveText(ACCEPTANCES_COPY.send.choice.lost);
    await page.getByRole('button', { name: ACCEPTANCES_COPY.tryAgain }).click();
    await page.waitForURL(`**/orgs/${host.org.slug}/dashboard?welcome=1`);
    const join = `/api/v1/invitations/${raw}`;
    expect(posts).toEqual([join, '/api/acceptances', '/api/acceptances', join]);
    expect(bodies[1]).toBe(bodies[0]);
    expect(await testDb.membership.count({ where: { userId: invitee.userId, orgId: host.org.id } })).toBe(1);
    await page.context().close();
  });

  test('FR-RES-01 FR-PUB-01: S-04\'s second step and S-05 offer no research control and show no product claim', async ({ browser }) => {
    // C4 SFH-3: the two pages whose job is consent boxes; the crawl of no-research-consent.spec.ts also renders S-05.
    const noResearchControl = async (page: Page, where: string) => {
      await expect(page.getByRole('checkbox').first(), where).toBeVisible();
      for (const role of ['checkbox', 'radio', 'switch'] as const) {
        await expect(page.getByRole(role, { name: /research/i }), `${where}: ${role}`).toHaveCount(0);
      }
      // PUB's word list (lib/claims/pattern.ts) over the words shown: the claims crawl has no seat that reaches S-05.
      expect(claimMatches(await page.locator('body').innerText()).map((m) => m.text), `${where}: claims`).toEqual([]);
    };
    const fx = await buildOrg({ label: 'resnone', acceptances: 'pre-v1' });
    const raw = await invitationFor(fx, `res-${Date.now()}@fixture.test`, 'viewer');
    const s04 = await newPage(browser);
    await s04.goto(`/invitations/${raw}`);
    await s04.getByLabel(INVITATION_COPY.name).fill('No Research');
    await s04.locator('#new-password').fill('No-research-ok');
    await s04.getByRole('button', { name: INVITATION_COPY.continue }).click();
    await noResearchControl(s04, 'S-04 step 2');
    await s04.context().close();
    const s05 = await newPage(browser);
    await signIn(s05, fx.members.owner);
    await expect(s05).toHaveURL(/\/acceptances$/);
    await noResearchControl(s05, 'S-05');
    await s05.context().close();
  });

  test('UX-22: each S-05 link has "(opens in a new tab)" in its accessible name', async ({ browser }) => {
    const fx = await buildOrg({ label: 'newtab', acceptances: 'pre-v1' });
    const page = await newPage(browser);
    await signIn(page, fx.members.viewer);
    await expect(page).toHaveURL(/\/acceptances$/);
    const links = page.getByRole('link', { name: /\(opens in a new tab\)$/ });
    await expect(links).toHaveCount(3);
    for (const link of await links.all()) await expect(link).toHaveAttribute('target', '_blank');
    await page.context().close();
  });

  test('NFR-A11Y-02: J-03 completes with the keyboard alone, focus visible and uncovered at each step', async ({ browser }) => {
    const fx = await buildOrg({ label: 'keys' });
    const email = `keys-${Date.now()}@fixture.test`;
    const raw = await invitationFor(fx, email, 'viewer');
    const page = await newPage(browser);
    await page.goto(`/invitations/${raw}`);
    await tabTo(page, page.getByLabel(INVITATION_COPY.name));
    await page.keyboard.type('Key Board');
    await tabTo(page, page.locator('#new-password'));
    await page.keyboard.type('Keyboard-only-ok');
    await tabTo(page, page.getByRole('button', { name: INVITATION_COPY.continue }));
    await page.keyboard.press('Enter');
    await expect(page.locator('#acceptances-step')).toBeFocused();
    for (const box of await page.getByRole('checkbox').all()) {
      await tabTo(page, box);
      await page.keyboard.press('Space');
      await expect(box).toBeChecked();
    }
    await tabTo(page, page.getByRole('button', { name: INVITATION_COPY.createAccount }));
    await page.keyboard.press('Enter');
    await page.waitForURL(`**/orgs/${fx.org.slug}/dashboard?welcome=1`);
    expect(await userCount(email)).toBe(1);
    await page.context().close();
  });

  test('NFR-A11Y-04 NFR-A11Y-05: S-04, S-05 and S-06 have no serious axe violation in both themes at 1280 and 360 pixels, targets of 24 pixels, and no loss at 320 pixels', async ({ browser }) => {
    test.setTimeout(3 * 60_000);
    const fx = await buildOrg({ label: 'axe', acceptances: 'pre-v1' });
    const raw = await invitationFor(fx, `axe-${Date.now()}@fixture.test`, 'viewer');
    const signedOut = await newPage(browser);
    const signedIn = await newPage(browser);
    await signIn(signedIn, fx.members.viewer);
    const states: Array<[string, Page, string, ((p: Page) => Promise<void>) | null]> = [
      ['S-04 step 1', signedOut, `/invitations/${raw}`, null],
      ['S-04 step 2', signedOut, `/invitations/${raw}`, async (p) => {
        await p.getByLabel(INVITATION_COPY.name).fill('Axe Check');
        await p.locator('#new-password').fill('Axe-check-ok-1');
        await p.getByRole('button', { name: INVITATION_COPY.continue }).click();
        await expect(p.locator('#acceptances-step')).toBeFocused();
      }],
      ['S-05', signedIn, '/acceptances', null],
      ['S-06 current', signedOut, '/legal/privacy', null],
      ['S-06 version', signedOut, '/legal/terms/1', null],
      ['S-06 retired agreement', signedOut, '/legal/organisation-agreement', null],
    ];
    for (const [name, page, path, then] of states) {
      for (const width of [1280, 360]) for (const colorScheme of ['light', 'dark'] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        await page.goto(path);
        if (then) await then(page);
        await expectNoSeriousA11yViolations(page, `${name}, ${colorScheme}, ${width}px`);
        await expectTargetsAtLeast24px(page);
      }
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto(path);
      if (then) await then(page);
      await expectNoHorizontalScroll(page);
    }
    await signedOut.context().close();
    await signedIn.context().close();
  });

  test('FR-ACC-01: POST /api/auth/register answers 404 and creates no user', async ({ request }) => {
    // FR-ACC-01: the open sign-up route is gone. The old switch no longer exists (FR-OPS-03), so no setting can
    // bring it back; __tests__/integration/open-registration-removed.test.ts sets the old name and sees 404 too.
    const email = `open-reg-${Date.now()}@fixture.test`;
    const res = await request.post('/api/auth/register', { headers: { 'x-forwarded-for': nextClientIp() }, data: {
      name: 'Open Registration', email, orgName: 'Open Registration Org', password: 'SecurePass123!', termsAccepted: true,
    } });
    expect(res.status()).toBe(404);
    expect(await userCount(email)).toBe(0);   // by its own address: other specs create users in parallel
  });

  test('FR-ACC-01: GET /register answers 404', async ({ request }) => {
    expect((await request.get('/register')).status()).toBe(404);
  });

  test('FR-ACC-02: /legal/privacy and /legal/privacy/1 answer 200 without signing in and show the hash of the file', async ({ browser }) => {
    const page = await newPage(browser);
    const hashOf = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex').replace(/(.{4})(?!$)/g, '$1 ');
    const currentFile = `data/legal/privacy/${currentLegalText('privacy').version}.md`;
    for (const [path, file] of [['/legal/privacy', currentFile], ['/legal/privacy/1', 'data/legal/privacy/1.md']] as const) {
      expect((await page.goto(path))?.status(), path).toBe(200);
      await expect(page.locator('code')).toHaveText(hashOf(file));
    }
    await page.context().close();
  });
});
