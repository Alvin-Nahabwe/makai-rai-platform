import 'dotenv/config';
import { expect, test, type Page } from '@playwright/test';
import { buildOrg } from '../__tests__/helpers/recordFixture';
import { actAsSeat, fixtureOrgSlug, newProject, questionPath, seatRequest, stageOf } from './helpers/session';

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

