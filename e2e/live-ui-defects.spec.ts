import 'dotenv/config';
import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { MANIFEST_PATH, adminSeat, type FixtureManifest } from './fixtures/manifest';
import { buildOrg } from '../__tests__/helpers/recordFixture';
import { testDb } from '../__tests__/helpers/db';
import { actAsSeat, fixtureOrgSlug, newProject, questionPath, seatOf, seatRequest, stageOf } from './helpers/session';
import { API_COPY } from '../lib/http/api/copy';
import { ORG_COPY } from '../lib/org/copy';

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

test('U12 (a): at 390 wide in the dark theme, the Menu button text stands out from the button by at least 4.5:1', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await actAsSeat(page, 'owner');
  await page.goto(`/orgs/${fixtureOrgSlug()}/dashboard`);
  const button = page.locator('.shell-topbar__menu-button');
  await expect(button).toBeVisible();
  await expect(button).toHaveText('Menu');
  // The page is dark: the ground is the dark one, so the button is measured where the dark tokens apply.
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
  expect(await contrastOf(page, '.shell-topbar__menu-button', '.shell-topbar__menu-button', 'color')).toBeGreaterThanOrEqual(4.5);
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
    await expect(page.getByRole('heading', { level: 1, name: ORG_COPY.chooser.heading })).toBeVisible();
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

test.describe('U12 (c): at phone width the members and accounts tables keep every row action on the screen', () => {
  const PENDING_EMAIL = `u12c-pending-${Date.now()}@fixture.test`;

  test.beforeAll(async ({ baseURL }) => {
    // A pending invitation, so the invitations table has a row with Resend and Revoke.
    const owner = await seatRequest(baseURL!, 'owner');
    try {
      const made = await owner.post(`/api/v1/orgs/${fixtureOrgSlug()}/members`, {
        data: { requestId: crypto.randomUUID(), email: PENDING_EMAIL, role: 'reviewer', showLink: false },
      });
      expect(made.status(), 'the pending invitation').toBe(201);
    } finally {
      await owner.dispose();
    }
  });

  test.afterAll(async () => {
    try {
      await testDb.invitation.deleteMany({ where: { email: { startsWith: 'u12c-pending-' } } });
    } finally {
      await testDb.$disconnect();
    }
  });

  /**
   * Every row action whose box is not wholly inside the viewport AND inside the visible box of every ancestor that
   * scrolls or clips sideways (`.admin-table-wrapper` is `overflow-x: auto`: an action scrolled past its right edge is
   * inside the viewport by coordinates and still not on the screen). Also the page's own widths.
   */
  async function offScreenActions(page: Page, actions: string): Promise<{ outside: string[]; scrollWidth: number; clientWidth: number }> {
    return page.evaluate((selector) => {
      const root = document.documentElement;
      const outside: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const r = el.getBoundingClientRect();
        let left = 0;
        let right = root.clientWidth;
        let by = '';
        for (let a = el.parentElement; a && a !== root && a !== document.body; a = a.parentElement) {
          if (getComputedStyle(a).overflowX === 'visible') continue;
          const box = a.getBoundingClientRect();
          const l = box.left + a.clientLeft;
          const rt = l + a.clientWidth;
          if (r.left < l || r.right > rt) {
            // The innermost one that cuts the action is named: it is the box whose content is too wide.
            by ||= `${a.tagName.toLowerCase()}.${a.className.trim().split(/\s+/).join('.')}`;
            left = Math.max(left, l);
            right = Math.min(right, rt);
          }
        }
        if (r.left >= left - 0.5 && r.right <= right + 0.5) continue;
        outside.push(`"${el.getAttribute('aria-label') ?? el.textContent?.trim()}" spans ${Math.round(r.left)}-${Math.round(r.right)}, visible box ${Math.round(left)}-${Math.round(right)} (cut by ${by || 'the viewport'})`);
      }
      return { outside, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
    }, actions);
  }

  const pages: Array<{ name: string; path: () => string; seat: 'owner' | 'admin'; actions: string; expected: RegExp[]; widths: number[] }> = [
    {
      name: 'members',
      path: () => `/orgs/${fixtureOrgSlug()}/settings/members`,
      seat: 'owner',
      actions: '.admin-table button',
      expected: [/^Remove /, /^Resend invitation to /, /^Revoke invitation for /],
      widths: [320, 390],
    },
    {
      name: 'accounts',
      path: () => '/admin/accounts',
      seat: 'admin',
      actions: '.admin-table button',
      expected: [/^Deactivate /],
      // 1024: laptop and tablet landscape, where the card is wider than the stacking threshold but narrower than the table.
      widths: [320, 390, 1024],
    },
  ];

  for (const p of pages) {
    for (const width of p.widths) {
      test(`${p.name} at ${width} wide, light theme`, async ({ browser, baseURL }) => {
        const storageState = p.seat === 'admin' ? adminSeat().storageStatePath : seatOf('owner').storageStatePath;
        const ctx = await browser.newContext({ baseURL, storageState, colorScheme: 'light', viewport: { width, height: 800 } });
        const page = await ctx.newPage();
        try {
          await page.goto(p.path());
          await expect(page.locator('.admin-table').first()).toBeVisible();
          // Each kind of action this check is about is present, so an empty table cannot pass it.
          const labels = await page.locator(p.actions).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
          for (const re of p.expected) expect(labels.some((l) => re.test(l)), `${p.name}: an action matching ${re}`).toBe(true);
          const m = await offScreenActions(page, p.actions);
          expect(m.outside, `${p.name} at ${width}: row actions outside the viewport`).toEqual([]);
          expect(m.scrollWidth, `${p.name} at ${width}: document scrollWidth`).toBeLessThanOrEqual(m.clientWidth);
          // The stacked layout keeps the table's semantics. Playwright's own role queries read the tag, not what the
          // browser exposes, so the browser's accessibility tree is read through the protocol.
          const cdp = await ctx.newCDPSession(page);
          const { nodes } = await cdp.send('Accessibility.getFullAXTree');
          const exposed = (role: string) => nodes.filter((n) => !n.ignored && n.role?.value === role).length;
          const domRows = await page.locator('.admin-table tr').count();
          const domCells = await page.locator('.admin-table td').count();
          const domHeadings = await page.locator('.admin-table th').count();
          expect(exposed('table'), `${p.name} at ${width}: tables exposed`).toBe(await page.locator('.admin-table').count());
          expect(exposed('row'), `${p.name} at ${width}: rows exposed`).toBe(domRows);
          expect(exposed('columnheader'), `${p.name} at ${width}: column headings exposed`).toBe(domHeadings);
          expect(exposed('cell'), `${p.name} at ${width}: cells exposed`).toBe(domCells);
          // The label is drawn by ::before with empty alternative text, so the cell's accessible text does not start with it
          // (the column heading already names the column).
          if (width < 600) {
            const labels = await page.locator('.admin-table td[data-label]').evaluateAll((els) => [...new Set(els.map((e) => `${e.getAttribute('data-label')}: `))]);
            const spoken = nodes.filter((n) => !n.ignored && (n.role?.value === 'StaticText' || n.role?.value === 'cell')).map((n) => String(n.name?.value ?? ''));
            expect(spoken.filter((t) => labels.some((l) => t.startsWith(l))), `${p.name} at ${width}: accessible text that starts with its label`).toEqual([]);
          }
        } finally {
          await ctx.close();
        }
      });
    }
  }
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
    const unknownId = '3f2b8f0e-1c11-4d6e-9a55-0a1b2c3d4e5f';
    // The last address is opened as a page only: with the team export's page and API checks it would be a fourth export request.
    const addresses: Array<[string, boolean]> = [
      [`/api/v1/orgs/${org}/documents/${unknownId}/pdf`, true],
      ['/api/users/me/export', true],
      [`/api/v1/orgs/${org}/export`, true],
      [`/api/v1/orgs/${org}/export?projectId=${unknownId}`, false],
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
      expect(await res.json(), address).toEqual({ error: API_COPY.unauthenticated, code: 'unauthenticated' });
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
