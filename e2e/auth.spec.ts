import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';

/**
 * Sign-in through the real /login form. Accounts are created only from an invitation (FR-ACC-01;
 * e2e/acceptances.spec.ts drives that), so this signs in one of the fixture seats that
 * e2e/fixtures/auth.setup.ts built with K0a's buildTwoOrgFixture, whose acceptances let it past the
 * gate, from its own client address so the per-address sign-in limit is its own.
 */
const manifest: FixtureManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

test.describe('Authentication Flow', () => {
  test('a fixture account signs in and reaches its organisation dashboard', async ({ browser }) => {
    const seat = manifest.users.find((u) => u.role === 'assessor' && u.index === 1);
    if (!seat) throw new Error('auth.spec: no assessor seat in the fixture manifest');
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '10.46.0.1' } });
    const page = await context.newPage();

    await page.goto('/login');
    await page.fill('#email', seat.email);
    await page.fill('#password', seat.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname !== '/login');

    // `/` shows the picker or, once the org layout has recorded lastActiveOrgId, the dashboard
    // (lib/org-dispatch.ts); either way the account's own dashboard answers, signed in.
    const res = await page.goto(`/orgs/${seat.orgSlug}/dashboard`);
    expect(res?.status()).toBe(200);
    await expect(page.locator('h1')).toContainText('Dashboard');
    await context.close();
  });
});
