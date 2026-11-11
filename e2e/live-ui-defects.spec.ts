import 'dotenv/config';
import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { MANIFEST_PATH, adminSeat, type FixtureManifest } from './fixtures/manifest';
import { buildOrg } from '../__tests__/helpers/recordFixture';
import { actAsSeat, fixtureOrgSlug, newProject, questionPath, seatOf, seatRequest, stageOf } from './helpers/session';

/**
 * v0.6.1 U12 rows (a), (b), (d) and (e): four defects that were broken for people on v0.6.0, each checked at the
 * width and theme where it failed. Row (c) (the members and accounts tables) has its own diagnosis.
 */

/** WCAG 2 contrast of one element's `color` or background colour against another element's background (alpha is composited). */
async function contrastOf(page: Page, fgSelector: string, bgSelector: string, fgProperty: 'color' | 'backgroundColor'): Promise<number> {
  return page.evaluate(([fgSel, bgSel, prop]) => {
    const parse = (s: string): [number, number, number, number] => {
      const m = /rgba?\(([^)]+)\)/.exec(s);
      if (!m) throw new Error(`not a colour: ${s}`);
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const c = [r, g, b].map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const bgEl = document.querySelector(bgSel) as HTMLElement;
    const fgEl = document.querySelector(fgSel) as HTMLElement;
    const bg = parse(getComputedStyle(bgEl).backgroundColor);
    const fg = parse(getComputedStyle(fgEl)[prop as 'color' | 'backgroundColor']);
    const mixed = [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const [hi, lo] = [lum(mixed), lum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  }, [fgSelector, bgSelector, fgProperty] as const);
}

test('U12 (a): at 390 wide in the dark theme, the menu button bars stand out from the button by at least 3:1', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await actAsSeat(page, 'owner');
  await page.goto(`/orgs/${fixtureOrgSlug()}/dashboard`);
  const toggle = page.locator('.sidebar-toggle');
  await expect(toggle).toBeVisible();
  expect(await page.locator('.sidebar-toggle__bar').count()).toBeGreaterThan(0);
  expect(await contrastOf(page, '.sidebar-toggle__bar', '.sidebar-toggle', 'backgroundColor')).toBeGreaterThanOrEqual(3);
});

test('U12 (b): the organisation chooser shows its links on the card, at 4.5:1 or better, in the light theme', async ({ browser }) => {
  // A fixture seat may carry a last organisation from earlier runs and then skips the chooser, so this signs in a new account.
  const fx = await buildOrg({ label: 'chooser' });
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '10.49.0.2' }, colorScheme: 'light', viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto('/login');
    await page.fill('#email', fx.members.viewer.email);
    await page.fill('#password', fx.members.viewer.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname !== '/login');
    await page.goto('/');
    await expect(page.locator(`a[href="/orgs/${fx.org.slug}/dashboard"]`)).toBeVisible();
    expect(await contrastOf(page, '.auth-card nav a', '.auth-card', 'color')).toBeGreaterThanOrEqual(4.5);
    await expect(page.getByRole('heading', { level: 1, name: 'Choose an organisation' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('U12 (d): a viewer sees the current decision\'s reason and evidence names on the question page', async ({ page, baseURL }) => {
  const Q = 'Q-PP-01';
  const projectId = await newProject(baseURL!);
  const owner = await seatRequest(baseURL!, 'owner');
  try {
    const org = fixtureOrgSlug();
    const ev = await owner.post(`/api/v1/orgs/${org}/projects/${projectId}/evidence`, {
      data: { requestId: crypto.randomUUID(), kind: 'link', url: 'https://example.org/audit-report', label: 'Audit report for U12' },
    });
    expect(ev.status(), 'evidence create').toBe(201);
    const evidenceId = ((await ev.json()) as { id: string }).id;
    const saved = await owner.post(`/api/v1/orgs/${org}/projects/${projectId}/decisions`, { data: {
      requestId: crypto.randomUUID(), stage: stageOf(Q), questionId: Q, baseVersionNumber: null, status: 'done', scopeAnswer: null,
      optionsInPlace: [], reasonCode: null, reason: 'We checked the data sources with the team.',
      decidedBy: { kind: 'outside_role', role: 'supervisor' }, declaredDate: '2026-10-12', evidenceIds: [evidenceId],
    } });
    expect(saved.status(), 'decision save').toBe(201);
  } finally {
    await owner.dispose();
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await actAsSeat(page, 'viewer');
  await page.goto(questionPath(projectId, Q));
  const region = page.locator('[data-region="current-decision"]');
  await expect(region).toContainText('We checked the data sources with the team.');
  await expect(region).toContainText('Audit report for U12');
  // A viewer has no form to record a decision.
  await expect(page.getByRole('button', { name: /save/i })).toHaveCount(0);
});

test.describe('U12 (e): a refused download address does not leave raw JSON on the screen', () => {
  const m = (): FixtureManifest => JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;

  test('a signed-out request to each download address ends on the sign-in page, and an API client still gets the JSON 401', async ({ browser }) => {
    // The proxy counts exports per client address (3 an hour), so this run uses an address of its own.
    const ip = `10.${50 + Math.floor(Math.random() * 100)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': ip } });
    const page = await context.newPage();
    const request = context.request;
    const org = m().orgs[0].slug;
    const projectId = '3f2b8f0e-1c11-4d6e-9a55-0a1b2c3d4e5f';
    // The last address is opened as a page only: with the team export's page and API checks it would be a fourth export request.
    const addresses: Array<[string, boolean]> = [
      [`/api/v1/orgs/${org}/documents/${projectId}/pdf`, true],
      ['/api/users/me/export', true],
      [`/api/v1/orgs/${org}/export`, true],
      [`/api/v1/orgs/${org}/export?projectId=${projectId}`, false],
    ];
    for (const [address, alsoAsApiClient] of addresses) {
      await page.context().clearCookies();
      await page.goto(address);
      expect(new URL(page.url()).pathname, address).toBe('/login');
      await expect(page.getByRole('heading', { level: 1 }), address).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'You are signed out. Sign in, then start the download again.' }), address).toBeVisible();
      // An API client (no browser navigation header) is unchanged: the JSON 401.
      if (!alsoAsApiClient) continue;
      const res = await request.get(address);
      expect(res.status(), address).toBe(401);
      expect(await res.json(), address).toEqual({ error: 'Unauthorized', code: 'unauthenticated' });
    }
    await context.close();
  });

  test('a form post that the accounts route cannot read goes back to the accounts page with one line', async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({ baseURL, storageState: adminSeat().storageStatePath });
    const page = await ctx.newPage();
    try {
      await page.goto('/admin/accounts');
      const targetId = seatOf('owner').userId;
      await page.evaluate((id) => {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = `/api/admin/users/${id}/role`;
        const f = document.createElement('input');
        f.name = 'unknown'; f.value = 'x';
        form.append(f);
        document.body.append(form);
        form.submit();
      }, targetId);
      await page.waitForURL((u) => u.pathname === '/admin/accounts' && u.searchParams.has('error'));
      await expect(page.locator('#accounts-refusal')).toHaveText('That change could not be made. Reload the page and try again.');
    } finally {
      await ctx.close();
    }
  });
});
