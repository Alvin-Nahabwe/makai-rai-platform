import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import { buildOrg, type FixtureAccount, type OrgFixture } from '../__tests__/helpers/recordFixture';

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
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`You are invited to ${fx.org.name}`);
    await expect(page.getByText(new RegExp(`^${fx.members.owner.name} invited you as an assessor\\. The invitation expires on \\d{1,2} [A-Z][a-z]{2} \\d{4}\\.$`))).toBeVisible();
    await expect(page.getByLabel(/^Email/)).toHaveValue(email);

    // 7.4.2 S-04 validation: Continue with nothing typed stays on step 1 and names both fields.
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByLabel('Your name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Your name')).toBeFocused();
    await expect(page.getByLabel('Password', { exact: true })).toHaveAccessibleDescription(/Password is required/);

    await page.getByLabel('Your name').fill('Jay Three');
    await page.getByLabel('Password', { exact: true }).fill('J03-password-ok');
    await page.getByRole('button', { name: 'Show' }).click();
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Continue' }).click();
    // Step 1's form and its button are gone: focus moves to step 2, not to the page body (WCAG 2.4.3).
    await expect(page.locator('#acceptances-step')).toBeFocused();

    // UX-22: three unticked boxes, each link says it opens a new tab.
    await expect(page.getByRole('checkbox')).toHaveCount(3);
    for (const box of await page.getByRole('checkbox').all()) await expect(box).not.toBeChecked();
    await expect(page.getByRole('link', { name: /\(opens in a new tab\)$/ })).toHaveCount(3);

    // Two ticks: M-25 names the third, focus moves to it, and nothing is sent.
    await page.getByLabel('I accept the terms of service.').check();
    await page.getByLabel('I have read the privacy notice.').check();
    await page.getByRole('button', { name: 'Create account' }).click();
    const summary = page.locator('#acceptances-errors');   // Next's own route announcer is also role=alert
    await expect(summary).toHaveAttribute('role', 'alert');
    await expect(summary).toHaveText('To continue, accept the cross-border storage consent.');
    await expect(page.getByLabel(/cross-border storage consent describes/)).toBeFocused();
    await expect(page.getByLabel(/cross-border storage consent describes/)).toHaveAttribute('aria-invalid', 'true');
    expect(posts).toEqual([]);
    expect(await userCount(email)).toBe(0);

    await page.getByLabel(/cross-border storage consent describes/).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL(`**/orgs/${fx.org.slug}/dashboard?welcome=1`);
    expect(new URL(page.url()).search).toBe('?welcome=1');
    const user = await testDb.user.findUniqueOrThrow({ where: { email } });
    expect(await testDb.consentRecord.count({ where: { userId: user.id } })).toBe(3);
    expect(await testDb.membership.findMany({ where: { userId: user.id }, select: { orgId: true, role: true } }))
      .toEqual([{ orgId: fx.org.id, role: 'assessor' }]);

    // The same link again: M-23 and nothing else.
    await page.goto(`/invitations/${raw}`);
    await expect(page.getByText('This invitation link does not work. It may have expired, been used, or been replaced by a newer one. Ask the person who invited you to send it again.')).toBeVisible();
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

    // C4 CR-1 / SE-1: a click in the sidebar is a client-side navigation, which does not re-render the
    // shared (authenticated) layout; each destination must still send the account back to S-05.
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    for (const name of ['Dashboard', 'Projects', 'Members', 'Framework', 'Controls', 'About', 'Switch organization']) {
      await page.goto('/acceptances');
      const link = nav.getByRole('link', { name });
      const href = await link.getAttribute('href');
      // The router's own request for the destination (not a prefetch), so the check waits for the server's answer.
      const answered = page.waitForResponse((r) => new URL(r.url()).pathname === href && r.request().headers()['rsc'] === '1'
        && r.request().headers()['next-router-prefetch'] === undefined);
      await link.click();
      await answered;
      await expect(page, `${name} (${href})`).toHaveURL(/\/acceptances$/);
      await expect(page.getByRole('heading', { level: 1 }), name).toHaveText('Before you continue');
    }

    // S-05: one box unticked sends nothing and moves focus to it.
    const posts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/acceptances')) posts.push(r.url()); });
    await page.goto('/acceptances');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Before you continue');
    await expect(page.getByRole('link', { name: /\(opens in a new tab\)$/ })).toHaveCount(3);
    await page.getByLabel('I accept the terms of service.').check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    const summary = page.locator('#acceptances-errors');
    await expect(summary).toHaveAttribute('role', 'alert');
    await expect(summary).toContainText('To continue, accept the privacy notice.');
    await expect(summary).toContainText('To continue, accept the cross-border storage consent.');
    await expect(page.getByLabel('I have read the privacy notice.')).toBeFocused();
    expect(posts).toEqual([]);

    await page.getByLabel('I have read the privacy notice.').check();
    await page.getByLabel(/cross-border storage consent describes/).check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    await page.waitForURL((url) => url.pathname !== '/acceptances');
    expect(posts).toHaveLength(1);
    const res = await page.goto(`/orgs/${fx.org.slug}/dashboard`);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/orgs/${fx.org.slug}/dashboard$`));
    await page.context().close();
  });

  test('FR-ACC-01: POST /api/auth/register answers 404 and creates no user', async ({ request }) => {
    // The server runs with ALLOW_OPEN_REGISTRATION=true, set in playwright.config.ts's webServer env for
    // this check (CI's e2e job no longer sets it: nothing in the app reads it).
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
    const hash = createHash('sha256').update(readFileSync('data/legal/privacy/1.md')).digest('hex').replace(/(.{4})(?!$)/g, '$1 ');
    for (const path of ['/legal/privacy', '/legal/privacy/1']) {
      expect((await page.goto(path))?.status(), path).toBe(200);
      await expect(page.locator('code')).toHaveText(hash);
    }
    await page.context().close();
  });
});
