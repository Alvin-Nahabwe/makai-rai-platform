import 'dotenv/config';
import fs from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import { buildOrg, type FixtureAccount, type OrgFixture } from '../__tests__/helpers/recordFixture';
import { MANIFEST_PATH, adminSeat, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { expectNoHorizontalScroll } from './helpers/reflow';

/**
 * Plan 1A Task 11: the shell in a browser (the lead's additions, section 8). Each case says where a thing is, not only that
 * it is there: the rail's column from 1024 px, the top bar and its Menu panel below, the panel with JavaScript off, long
 * names at 320 px, the organisation switcher, the theme switch, the skip link, axe in both themes, the session dialogs,
 * signing out with a draft, print, and targets and focus in the open panel.
 *
 * Seats of the fixture manifest are only read. The person in two organisations, with long names, is made here with
 * buildOrg and testDb on rows no other spec uses (FR-ACC-04's way in e2e/acceptances.spec.ts).
 */

const WARNING = 'You will be signed out in 2 minutes because nothing has happened for a while.';
const ENDED = 'You have been signed out. What you typed is still on this page.';
const ORG_ITEMS = ['Home', 'Projects', 'Findings', 'Guidance', 'Members', 'Organisation details', 'My account'];
/** 70 characters, no hyphen and no space: the hardest organisation name to fit in the rail. */
const LONG_ORG_NAME = 'Kampalanakasongolaresponsibleartificialintelligencelaboratoryformakere';
const PERSON_NAME = 'Ssekandi Nnaŋŋa';

function manifest(): FixtureManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as FixtureManifest;
}
function seat(role: string): { slug: string; seat: FixtureManifestUser } {
  const m = manifest();
  const slug = m.orgs[0].slug;
  const found = m.users.find((u) => u.orgSlug === slug && u.role === role && u.index === 0);
  if (!found) throw new Error(`shell-redesign.spec: no ${role} seat for ${slug}`);
  return { slug, seat: found };
}

async function contextAs(browser: Browser, storageState: string | Awaited<ReturnType<BrowserContext['storageState']>>, opts: Parameters<Browser['newContext']>[0] = {}) {
  return browser.newContext({ storageState, ...opts });
}

/** The value a colour token resolves to on this page, in the browser's own form (rgb(...)). */
async function resolved(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${t})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, token);
}

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  if (b === null) throw new Error(`${selector} has no box`);
  return b;
}

/** Waits until React has attached to the shell (the hydration signal e2e/csp.spec.ts uses). */
async function hydrated(page: Page, selector = '.shell-topbar__menu-button'): Promise<void> {
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return el !== null && Object.keys(el).some((k) => k.startsWith('__reactFiber$'));
  }, selector);
}

const railLinks = (page: Page) => page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link');

// ── The person in two organisations, with long names, made for this spec ─────────────────────────────────────────────

let ipSeq = 0;
const nextClientIp = () => `10.52.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

type Person = { a: OrgFixture; b: OrgFixture; account: FixtureAccount; state: Awaited<ReturnType<BrowserContext['storageState']>> };
let person: Person | null = null;

/** Owner of organisation A (named with 70 characters), viewer of organisation B, named "Ssekandi Nnaŋŋa"; signed in once. */
async function twoOrgPerson(browser: Browser): Promise<Person> {
  if (person) return person;
  const a = await buildOrg({ label: 'shla' });
  const b = await buildOrg({ label: 'shlb' });
  const account = a.members.owner;
  await testDb.organization.update({ where: { id: a.org.id }, data: { name: LONG_ORG_NAME } });
  await testDb.user.update({ where: { id: account.userId }, data: { name: PERSON_NAME } });
  await testDb.membership.create({ data: { orgId: b.org.id, userId: account.userId, role: 'viewer' } });
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': nextClientIp() } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
  const state = await context.storageState();
  await context.close();
  person = { a: { ...a, org: { ...a.org, name: LONG_ORG_NAME } }, b, account, state };
  return person;
}

test.afterAll(async () => {
  await testDb.$disconnect();
});

// ── 1. The rail at 1280 px ───────────────────────────────────────────────────────────────────────────────────────────

test('1A Task 11 (1): at 1280 px the rail is the first column, full height, Home is an orange fill, and no rail text is orange', async ({ browser }) => {
  const { slug, seat: owner } = seat('owner');
  const context = await contextAs(browser, owner.storageStatePath, { viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto(`/orgs/${slug}/dashboard`);
    const railWidth = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rail-width')));
    expect(railWidth).toBe(248);
    const rail = await box(page, '.shell-topbar__panel');
    expect(rail.x).toBe(0);
    expect(Math.abs(rail.width - railWidth)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(rail.height - 800)).toBeLessThanOrEqual(1);
    await expect(page.locator('.shell-topbar')).toBeHidden();
    const main = await box(page, 'main');
    expect(main.x).toBeGreaterThanOrEqual(rail.x + rail.width - 0.5);

    await expect(railLinks(page)).toHaveText(ORG_ITEMS);
    const home = railLinks(page).filter({ hasText: 'Home' });
    await expect(home).toHaveAttribute('aria-current', 'page');
    const action = await resolved(page, '--color-action');
    const onAction = await resolved(page, '--color-on-action');
    expect(await home.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(action);
    expect(await home.evaluate((el) => getComputedStyle(el).color)).toBe(onAction);

    const orange = new Set([action, await resolved(page, '--color-action-text'), await resolved(page, '--color-selected')]);
    const colours = await page.locator('.shell-rail, .shell-rail *, .shell-topbar, .shell-topbar *').evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
    expect(colours.length).toBeGreaterThan(10);
    expect(colours.filter((c) => orange.has(c)), 'text on the rail or the bar painted orange').toEqual([]);
  } finally {
    await context.close();
  }
});

test("1A Task 11 (1): a viewer's rail reads Viewer under the name; the administrator's has Organisations and Accounts and reads MAK-AI administrator", async ({ browser }) => {
  const { slug, seat: viewer } = seat('viewer');
  const v = await contextAs(browser, viewer.storageStatePath, { viewport: { width: 1280, height: 800 } });
  try {
    const page = await v.newPage();
    await page.goto(`/orgs/${slug}/dashboard`);
    await expect(page.locator('.shell-rail__role')).toHaveText('Viewer');
    await expect(page.locator('.shell-rail__role')).toBeVisible();
  } finally {
    await v.close();
  }
  const admin = await contextAs(browser, adminSeat().storageStatePath, { viewport: { width: 1280, height: 800 } });
  try {
    const page = await admin.newPage();
    await page.goto('/admin/organisations');
    await expect(railLinks(page)).toHaveText(['Organisations', 'Accounts', 'My account']);
    await expect(railLinks(page).filter({ hasText: 'Organisations' })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.shell-rail__role')).toHaveText('MAK-AI administrator');
    await expect(page.locator('.shell-org')).toHaveCount(0);
  } finally {
    await admin.close();
  }
});

// ── 2. The top bar and the Menu panel ────────────────────────────────────────────────────────────────────────────────

for (const width of [1023, 375]) {
  test(`1A Task 11 (2): at ${width} px the top bar leads the page and Menu opens the panel below it, edge to edge`, async ({ browser }) => {
    const { slug, seat: owner } = seat('owner');
    const context = await contextAs(browser, owner.storageStatePath, { viewport: { width, height: 700 } });
    try {
      const page = await context.newPage();
      await page.goto(`/orgs/${slug}/dashboard`);
      await hydrated(page);
      const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
      const shell = await box(page, '.shell');
      const bar = await box(page, '.shell-topbar');
      expect(bar.y).toBe(shell.y);
      expect(bar.x).toBe(0);
      expect(Math.abs(bar.width - viewportWidth)).toBeLessThanOrEqual(0.5);
      const menu = page.locator('.shell-topbar__menu-button');
      await expect(menu).toBeVisible();
      await expect(menu).toHaveText('Menu');
      expect((await menu.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect(page.locator('.shell-rail')).toBeHidden();
      await expect(menu).toHaveAttribute('aria-expanded', 'false');

      await menu.click();
      const panel = page.locator('.shell-topbar__panel');
      await expect(panel).toBeVisible();
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      const p = await box(page, '.shell-topbar__panel');
      expect(Math.abs(p.y - (bar.y + bar.height)), 'the panel starts at the bar\'s bottom edge').toBeLessThanOrEqual(2);
      expect(p.x).toBe(0);
      expect(Math.abs(p.x + p.width - viewportWidth)).toBeLessThanOrEqual(0.5);
      expect(p.y + p.height).toBeLessThanOrEqual(700 + 0.5);
      await expect(railLinks(page)).toHaveText(ORG_ITEMS);
      for (const link of await railLinks(page).all()) {
        await link.scrollIntoViewIfNeeded();
        const l = (await link.boundingBox())!;
        expect(l.y, await link.innerText()).toBeGreaterThanOrEqual(p.y - 0.5);
        expect(l.y + l.height, await link.innerText()).toBeLessThanOrEqual(700 + 0.5);
      }

      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await expect(menu).toBeFocused();

      await menu.click();
      await railLinks(page).filter({ hasText: 'Projects' }).click();
      await page.waitForURL((url) => url.pathname === `/orgs/${slug}/projects`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(panel).toBeHidden();
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
    } finally {
      await context.close();
    }
  });
}

test('1A Task 11 (2): the panel opened at 375 px gives way to the rail\'s column when the window is widened to 1280 px', async ({ browser }) => {
  const { slug, seat: owner } = seat('owner');
  const context = await contextAs(browser, owner.storageStatePath, { viewport: { width: 375, height: 700 } });
  try {
    const page = await context.newPage();
    await page.goto(`/orgs/${slug}/dashboard`);
    await hydrated(page);
    await page.locator('.shell-topbar__menu-button').click();
    await expect(page.locator('.shell-topbar__panel')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(() => page.evaluate(() => document.querySelectorAll(':popover-open').length)).toBe(0);
    const rail = await box(page, '.shell-topbar__panel');
    expect(rail.x).toBe(0);
    expect(Math.abs(rail.width - 248)).toBeLessThanOrEqual(0.5);
    await expect(page.locator('.shell-topbar')).toBeHidden();
    const main = await box(page, 'main');
    const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('main'), [main.x + main.width / 2, main.y + 40]);
    expect(hit, 'main is not covered').toBe(true);
    await railLinks(page).filter({ hasText: 'Projects' }).click();
    await page.waitForURL((url) => url.pathname === `/orgs/${slug}/projects`);
  } finally {
    await context.close();
  }
});

// ── 3. JavaScript off ────────────────────────────────────────────────────────────────────────────────────────────────

test('1A Task 11 (3) Review Focus 5: with JavaScript off the Menu button opens the panel at 375 px, and the rail is a column at 1280 px', async ({ browser }) => {
  const { slug, seat: owner } = seat('owner');
  const context = await contextAs(browser, owner.storageStatePath, { javaScriptEnabled: false, viewport: { width: 375, height: 700 } });
  try {
    const page = await context.newPage();
    await page.goto(`/orgs/${slug}/dashboard`);
    await expect(page.locator('.shell-topbar__panel')).toBeHidden();
    await page.locator('.shell-topbar__menu-button').click();
    const panel = page.locator('.shell-topbar__panel');
    await expect(panel).toBeVisible();
    const bar = await box(page, '.shell-topbar');
    const p = await box(page, '.shell-topbar__panel');
    expect(p.x).toBe(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y, 'the panel does not cover the bar').toBeGreaterThanOrEqual(bar.y + bar.height - 0.5);
    expect(Math.abs(p.x + p.width - 375)).toBeLessThanOrEqual(0.5);
    expect(p.y + p.height).toBeLessThanOrEqual(700 + 0.5);
    await railLinks(page).filter({ hasText: 'Projects' }).click();
    await page.waitForURL((url) => url.pathname === `/orgs/${slug}/projects`);

    // L2-45's assumption: author CSS shows a closed [popover] in flow. With no script nothing could open it.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/orgs/${slug}/dashboard`);
    expect(await page.evaluate(() => document.querySelectorAll(':popover-open').length)).toBe(0);
    await expect(page.locator('.shell-rail')).toBeVisible();
    const rail = await box(page, '.shell-topbar__panel');
    expect(rail.x).toBe(0);
    expect(Math.abs(rail.width - 248)).toBeLessThanOrEqual(0.5);
    await railLinks(page).filter({ hasText: 'Members' }).click();
    await page.waitForURL((url) => url.pathname === `/orgs/${slug}/settings/members`);
  } finally {
    await context.close();
  }
});

// ── 4. Long names ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Nothing of the bar or the open panel is wider than the viewport, and each name is whole and fits its box. */
async function expectNamesFit(page: Page, names: readonly string[]): Promise<void> {
  await expectNoHorizontalScroll(page);
  const report = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('.shell-topbar, .shell-topbar *, .shell-topbar__panel, .shell-topbar__panel *')]
      .filter((e) => getComputedStyle(e).display !== 'none')
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5); })
      .map((e) => `${e.tagName.toLowerCase()}.${(e as HTMLElement).className}`);
    const overflowing = [...document.querySelectorAll('.shell-rail__name, .shell-org__name, .shell-topbar__title, .shell-rail__product')]
      .filter((e) => getComputedStyle(e).display !== 'none')
      .filter((e) => (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth + 0.5)
      .map((e) => `${(e as HTMLElement).className}: ${(e as HTMLElement).scrollWidth} > ${(e as HTMLElement).clientWidth}`);
    return { wide, overflowing };
  });
  expect(report.wide, 'shell elements wider than the viewport').toEqual([]);
  expect(report.overflowing, 'names cut or overflowing').toEqual([]);
  const text = await page.locator('.shell-topbar__panel').innerText();
  for (const name of names) expect(text.replace(/\s+/g, ''), name).toContain(name.replace(/\s+/g, ''));
}

test('1A Task 11 (4) Review Focus 2: a 70-character organisation name and "Ssekandi Nnaŋŋa" reflow at 320 px, closed and open, and at 1280 px', async ({ browser }) => {
  const p = await twoOrgPerson(browser);
  const context = await contextAs(browser, p.state, { viewport: { width: 320, height: 700 } });
  try {
    const page = await context.newPage();
    await page.goto(`/orgs/${p.a.org.slug}/dashboard`);
    await hydrated(page);
    await expectNoHorizontalScroll(page);
    const menu = await box(page, '.shell-topbar__menu-button');
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(320 + 0.5);
    await page.locator('.shell-topbar__menu-button').click();
    await expect(page.locator('.shell-topbar__panel')).toBeVisible();
    await expectNamesFit(page, [LONG_ORG_NAME, PERSON_NAME]);

    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('.shell-rail')).toBeVisible();
    await expectNamesFit(page, [LONG_ORG_NAME, PERSON_NAME]);
  } finally {
    await context.close();
  }
});

// ── 5. The organisation switcher ─────────────────────────────────────────────────────────────────────────────────────

test('1A Task 11 (5): one organisation is a name; two are a switcher whose list opens under its button and lands on the other dashboard', async ({ browser }) => {
  const { slug, seat: owner } = seat('owner');
  const one = await contextAs(browser, owner.storageStatePath, { viewport: { width: 1280, height: 800 } });
  try {
    const page = await one.newPage();
    await page.goto(`/orgs/${slug}/dashboard`);
    await expect(page.locator('.shell-org .shell-org__name')).toBeVisible();
    await expect(page.locator('.shell-org__button')).toHaveCount(0);
  } finally {
    await one.close();
  }

  const p = await twoOrgPerson(browser);
  const two = await contextAs(browser, p.state, { viewport: { width: 1280, height: 800 } });
  try {
    const page = await two.newPage();
    await page.goto(`/orgs/${p.a.org.slug}/dashboard`);
    await hydrated(page, '.shell-org__button');
    const button = page.locator('.shell-org__button');
    await expect(button).toContainText(LONG_ORG_NAME);
    await expect(button).toContainText('Switch organisation');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.shell-org__list a')).toHaveCount(0);
    await expect(page.locator('.shell-rail__role')).toHaveText('Owner');

    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const b = await box(page, '.shell-org__button');
    const list = await box(page, '.shell-org__list');
    const rail = await box(page, '.shell-rail');
    expect(list.y).toBeGreaterThanOrEqual(b.y + b.height - 0.5);
    expect(list.x).toBeGreaterThanOrEqual(rail.x);
    expect(list.x + list.width).toBeLessThanOrEqual(rail.x + rail.width + 0.5);
    const links = page.locator('.shell-org__list a');
    await expect(links).toHaveCount(2);
    await expect(links.filter({ hasText: LONG_ORG_NAME })).toHaveAttribute('aria-current', 'true');
    await expect(links.filter({ hasText: p.b.org.name })).not.toHaveAttribute('aria-current', /.*/);
    await expectNoSeriousA11yViolations(page, 'switcher open, light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoSeriousA11yViolations(page, 'switcher open, dark');
    await page.emulateMedia({ colorScheme: 'light' });

    await links.filter({ hasText: p.b.org.name }).click();
    await page.waitForURL((url) => url.pathname === `/orgs/${p.b.org.slug}/dashboard`);
    await expect(page.locator('.shell-rail__role')).toHaveText('Viewer');
    await expect(button).toContainText(p.b.org.name);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.shell-org__list a')).toHaveCount(0);
  } finally {
    await two.close();
  }
});

// ── 6. The theme switch ──────────────────────────────────────────────────────────────────────────────────────────────

/** Records, as the page loads, the first value of <html data-theme> and whether React had attached to anything by then. */
async function watchFirstTheme(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __firstTheme?: { value: string | null; reactRan: boolean } };
    const record = () => {
      if (w.__firstTheme) return;
      const value = document.documentElement?.getAttribute('data-theme') ?? null;
      if (value === null) return;
      const reactRan = [...document.querySelectorAll('*')].some((el) => Object.keys(el).some((k) => k.startsWith('__reactFiber$')));
      w.__firstTheme = { value, reactRan };
    };
    // The init script runs before <html> exists, so the observer watches the document and its subtree.
    new MutationObserver(record).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-theme'] });
    document.addEventListener('DOMContentLoaded', record);
  });
}

async function shownThemeWords(page: Page, scope: string): Promise<string[]> {
  return page.locator(`${scope} .shell-theme span`).evaluateAll((els) => els.filter((e) => getComputedStyle(e).display !== 'none').map((e) => (e as HTMLElement).innerText.trim()));
}

for (const where of [{ name: 'the rail', signedIn: true, scope: '.shell-rail' }, { name: 'the public header', signedIn: false, scope: '.shell-public-header' }]) {
  test(`1A Task 11 (6): the theme switch in ${where.name} names the other theme, persists, and shows the right words before any script`, async ({ browser }) => {
    const { slug, seat: owner } = seat('owner');
    const url = where.signedIn ? `/orgs/${slug}/dashboard` : '/login';
    const context = await browser.newContext({ colorScheme: 'light', viewport: { width: 1280, height: 800 }, ...(where.signedIn ? { storageState: owner.storageStatePath } : {}) });
    try {
      const page = await context.newPage();
      await watchFirstTheme(page);
      await page.goto(url);
      await page.evaluate(() => localStorage.removeItem('theme'));
      await page.reload();
      await hydrated(page, `${where.scope} .shell-theme`);
      expect(await shownThemeWords(page, where.scope)).toEqual(['Switch to dark theme']);
      await page.locator(`${where.scope} .shell-theme`).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(await shownThemeWords(page, where.scope)).toEqual(['Switch to light theme']);
      expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');

      await page.reload();
      const first = await page.evaluate(() => (window as unknown as { __firstTheme?: { value: string; reactRan: boolean } }).__firstTheme);
      expect(first, 'data-theme was set while the page loaded').toEqual({ value: 'dark', reactRan: false });
      expect(await shownThemeWords(page, where.scope)).toEqual(['Switch to light theme']);
      await page.evaluate(() => localStorage.removeItem('theme'));
    } finally {
      await context.close();
    }

    // Nothing stored and a dark system: CSS alone picks the words, so they are right with no script at all.
    const dark = await browser.newContext({ colorScheme: 'dark', javaScriptEnabled: false, viewport: { width: 1280, height: 800 }, ...(where.signedIn ? { storageState: owner.storageStatePath } : {}) });
    try {
      const page = await dark.newPage();
      await page.goto(url);
      expect(await shownThemeWords(page, where.scope)).toEqual(['Switch to light theme']);
    } finally {
      await dark.close();
    }
  });
}

// ── 7. The skip link ─────────────────────────────────────────────────────────────────────────────────────────────────

test('1A Task 11 (7) UX-04: the skip link is the first Tab stop, signed in and signed out, and Enter moves focus to main', async ({ browser }) => {
  const { slug, seat: owner } = seat('owner');
  for (const [state, url] of [[owner.storageStatePath, `/orgs/${slug}/dashboard`], [undefined, '/about']] as const) {
    for (const width of [1280, 375]) {
      const context = await browser.newContext({ viewport: { width, height: 700 }, ...(state ? { storageState: state } : {}) });
      try {
        const page = await context.newPage();
        await page.goto(url);
        await page.keyboard.press('Tab');
        await expect(page.locator(':focus'), `${url} ${width}`).toHaveText('Skip to content');
        await expect(page.locator(':focus')).toHaveClass('skip-link');
        await page.keyboard.press('Enter');
        expect(await page.evaluate(() => document.activeElement?.tagName), `${url} ${width}`).toBe('MAIN');
      } finally {
        await context.close();
      }
    }
  }
});

// ── 8. axe ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('1A Task 11 (8): axe finds nothing serious in light or dark: the rail at 1280 px, the bar at 375 px closed and open, a public page', async ({ browser }) => {
  const { slug, seat: owner } = seat('owner');
  for (const colorScheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ colorScheme, storageState: owner.storageStatePath, viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      await page.goto(`/orgs/${slug}/dashboard`);
      await hydrated(page);
      await expectNoSeriousA11yViolations(page, `dashboard 1280 ${colorScheme}`);
      await page.setViewportSize({ width: 375, height: 700 });
      await expectNoSeriousA11yViolations(page, `dashboard 375 closed ${colorScheme}`);
      await page.locator('.shell-topbar__menu-button').click();
      await expect(page.locator('.shell-topbar__panel')).toBeVisible();
      await expectNoSeriousA11yViolations(page, `dashboard 375 open ${colorScheme}`);
    } finally {
      await context.close();
    }
    const out = await browser.newContext({ colorScheme, viewport: { width: 1280, height: 800 } });
    try {
      const page = await out.newPage();
      await page.goto('/about');
      await expectNoSeriousA11yViolations(page, `about ${colorScheme}`);
    } finally {
      await out.close();
    }
  }
});

// ── 9. The session dialogs ───────────────────────────────────────────────────────────────────────────────────────────

async function expiry(context: BrowserContext): Promise<number> {
  return (await context.cookies()).find((c) => /session-token/.test(c.name))?.expires ?? 0;
}

for (const width of [1280, 375]) {
  test(`1A Task 11 (9) UX-43: at ${width} px the warning is centred with Stay signed in focused, and the signed-out notice leads the page`, async ({ browser }) => {
    const { slug, seat: owner } = seat('owner');
    const context = await contextAs(browser, owner.storageStatePath, { viewport: { width, height: 700 } });
    try {
      const page = await context.newPage();
      await page.clock.install();
      await page.goto(`/orgs/${slug}/dashboard`);
      await hydrated(page, '.shell-idle dialog.ui-dialog');
      await page.waitForTimeout(300);
      const before = await expiry(context);
      expect(before).toBeGreaterThan(0);
      await page.clock.fastForward(before * 1000 - (await page.evaluate(() => Date.now())) - 115_000);
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText(WARNING, { timeout: 10_000 });
      await expect(page.getByRole('button', { name: 'Stay signed in' })).toBeFocused();
      const d = (await dialog.boundingBox())!;
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      expect(Math.abs(d.x + d.width / 2 - vw / 2), 'horizontal centre').toBeLessThanOrEqual(2);
      expect(Math.abs(d.y + d.height / 2 - 700 / 2), 'vertical centre').toBeLessThanOrEqual(2);
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.x + d.width).toBeLessThanOrEqual(vw + 0.5);
      expect(d.y).toBeGreaterThanOrEqual(0);
      expect(d.y + d.height).toBeLessThanOrEqual(700 + 0.5);

      // A read that finds the session over: the notice replaces the modal, at the top of the page, above the shell.
      await context.clearCookies();
      await page.getByRole('button', { name: 'Stay signed in' }).click();
      await expect(dialog).toHaveCount(0, { timeout: 10_000 });
      const notice = page.getByRole('alert').filter({ hasText: ENDED });
      await expect(notice).toBeVisible();
      const n = (await notice.boundingBox())!;
      const shell = await box(page, '.shell');
      expect(n.y + n.height).toBeLessThanOrEqual(shell.y + 0.5);
      expect(n.x).toBe(0);
      expect(Math.abs(n.width - vw)).toBeLessThanOrEqual(0.5);
      const link = notice.getByRole('link', { name: 'Sign in again' });
      const l = (await link.boundingBox())!;
      const uncovered = await link.evaluate((el, [x, y]) => { const hit = document.elementFromPoint(x, y); return hit !== null && (hit === el || el.contains(hit)); }, [l.x + l.width / 2, l.y + l.height / 2]);
      expect(uncovered, 'nothing covers Sign in again').toBe(true);
    } finally {
      await context.close();
    }
  });
}

// ── 10. Signing out with an unsaved draft ────────────────────────────────────────────────────────────────────────────

for (const width of [1280, 375]) {
  test(`1A Task 11 (10) M-41: at ${width} px Sign out with a draft on the device shows the warning inside the viewport, its controls uncovered`, async ({ browser }) => {
    const p = await twoOrgPerson(browser);
    const context = await contextAs(browser, p.state, { viewport: { width, height: 700 } });
    try {
      const page = await context.newPage();
      await page.goto(`/orgs/${p.a.org.slug}/dashboard`);
      await hydrated(page);
      // One draft of this account on this device, in the store's own key and shape (lib/client/drafts.ts).
      await page.evaluate(([userId, orgId]) => {
        const key = `makrai.draft.v1:${userId}:${orgId}:00000000-0000-4000-8000-000000000000:q:Q-PP-01`;
        localStorage.setItem(key, JSON.stringify({ baseVersionNumber: null, value: { reason: 'x' }, savedAt: new Date().toISOString(), savePressedAt: null, retry: { requestId: null, sentBody: null } }));
      }, [p.account.userId, p.a.org.id] as const);
      if (width < 1024) {
        await page.locator('.shell-topbar__menu-button').click();
        await expect(page.locator('.shell-topbar__panel')).toBeVisible();
      }
      const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
      await signOut.scrollIntoViewIfNeeded();
      await signOut.click();
      const warning = page.getByRole('alertdialog');
      await expect(warning).toBeVisible();
      const w = (await warning.boundingBox())!;
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      expect(w.x).toBeGreaterThanOrEqual(0);
      expect(w.y).toBeGreaterThanOrEqual(0);
      expect(w.x + w.width).toBeLessThanOrEqual(vw + 0.5);
      expect(w.y + w.height).toBeLessThanOrEqual(700 + 0.5);
      const controls = [warning.getByRole('link', { name: 'Go to them' }), warning.getByRole('button', { name: 'Delete them and sign out' }), warning.getByRole('button', { name: 'Cancel' })];
      for (const control of controls) {
        const c = (await control.boundingBox())!;
        const free = await control.evaluate((el, [x, y]) => { const hit = document.elementFromPoint(x, y); return hit !== null && (hit === el || el.contains(hit)); }, [c.x + c.width / 2, c.y + c.height / 2]);
        expect(free, await control.innerText()).toBe(true);
      }
      await warning.getByRole('button', { name: 'Cancel' }).click();
      await expect(warning).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe(`/orgs/${p.a.org.slug}/dashboard`);
      await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('makrai.draft.v1:')) localStorage.removeItem(k); });
    } finally {
      await context.close();
    }
  });
}

// ── 11. Print ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('1A Task 11 (11): printed, the page shows main and none of the bar, the panel, the public header or the footer', async ({ browser }) => {
  const { slug, seat: owner } = seat('owner');
  const context = await contextAs(browser, owner.storageStatePath, { viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto(`/orgs/${slug}/dashboard`);
    await page.emulateMedia({ media: 'print' });
    for (const selector of ['.shell-topbar', '.shell-topbar__panel', '.shell-footer']) await expect(page.locator(selector), selector).toBeHidden();
    await expect(page.locator('main')).toBeVisible();
    await page.goto('/about');
    await expect(page.locator('.shell-public-header')).toBeHidden();
    await expect(page.locator('main')).toBeVisible();
  } finally {
    await context.close();
  }
});

// ── 12. Targets and focus in the open panel ──────────────────────────────────────────────────────────────────────────

test('1A Task 11 (12): at 375 px every control of the bar and the open panel is at least 24 by 24 px, rail items 44 px high, and each focus ring shows', async ({ browser }) => {
  const p = await twoOrgPerson(browser);
  const context = await contextAs(browser, p.state, { viewport: { width: 375, height: 700 } });
  try {
    const page = await context.newPage();
    await page.goto(`/orgs/${p.a.org.slug}/dashboard`);
    await hydrated(page);
    const menu = page.locator('.shell-topbar__menu-button');
    await menu.click();
    await expect(page.locator('.shell-topbar__panel')).toBeVisible();
    const sizes = await page.locator('.shell-topbar a, .shell-topbar button, .shell-topbar__panel a, .shell-topbar__panel button').evaluateAll((els) =>
      els.filter((e) => getComputedStyle(e).display !== 'none').map((e) => { const r = e.getBoundingClientRect(); return { what: (e as HTMLElement).innerText.trim(), w: r.width, h: r.height }; }));
    expect(sizes.length).toBeGreaterThanOrEqual(10);
    for (const s of sizes) {
      expect(s.w, s.what).toBeGreaterThanOrEqual(24);
      expect(s.h, s.what).toBeGreaterThanOrEqual(24);
    }
    for (const h of await page.locator('.shell-rail__item').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);

    // Tab from the Menu button through the open panel: each control's ring shows, inside the viewport, uncovered.
    await menu.focus();
    let checked = 0;
    for (let i = 0; i < sizes.length; i += 1) {
      await page.keyboard.press('Tab');
      const inPanel = await page.evaluate(() => !!document.activeElement?.closest('.shell-topbar__panel'));
      if (!inPanel) break;
      await expectFocusVisibleAndUncovered(page);
      checked += 1;
    }
    expect(checked, 'controls of the panel reached by Tab').toBeGreaterThanOrEqual(10);
  } finally {
    await context.close();
  }
});
