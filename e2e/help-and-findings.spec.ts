import 'dotenv/config';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import { addProject, addStageReview, buildOrg, type FixtureAccount } from '../__tests__/helpers/recordFixture';
import { adminSeat } from './fixtures/manifest';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectNoHorizontalScroll } from './helpers/reflow';

/**
 * Plan 1A Task 12 in a browser: the rail's Findings link follows the last project opened (P2, L2-64), sign-out clears it
 * (L2-66, S4), the Projects page under ?for=findings (L2-65, S1 to S3), and Help, `/help`, for a signed-out visitor, a
 * member, the MAK-AI administrator and a person who still owes a step (L2-67 to L2-70, S5, S7).
 *
 * Every test makes its own organisation and accounts with buildOrg; no shared seat is changed. The platform has one
 * administrator (NFR-SEC-19), so the administrator's case reads the fixture's administrator seat as it is. Each context
 * signs in from its own client address, as e2e/acceptances.spec.ts does, so the per-address sign-in limit is not shared.
 */

const CHOOSE = 'Choose a project to see its findings.';
const PREFIX = 'makrai:last-project:';

let ipSeq = 0;
// 10.41.: no literal "10.41." in e2e/, and outside the one computed range there (live-ui-defects.spec.ts, 10.50 to 10.149).
const nextClientIp = () => `10.41.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

async function newContext(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
  return browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': nextClientIp() }, ...opts });
}

async function signIn(page: Page, account: Pick<FixtureAccount, 'email' | 'password'>): Promise<void> {
  await page.goto('/login');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
}

const rail = (page: Page) => page.getByRole('navigation', { name: 'Main', includeHidden: true });
// includeHidden: below 1024 px the rail sits in the closed Menu panel, out of the accessibility tree until it opens.
const railLink = (page: Page, name: string) => rail(page).getByRole('link', { name, exact: true, includeHidden: true });

/** Waits until React has attached to `selector` (the hydration signal e2e/csp.spec.ts uses). */
async function hydrated(page: Page, selector: string): Promise<void> {
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return el !== null && Object.keys(el).some((k) => k.startsWith('__reactFiber$'));
  }, selector);
}

/** Copied from e2e/shell-redesign.spec.ts (a spec does not import a spec): waits until nothing scrolls for five frames. */
async function scrollSettled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const position = () => `${window.scrollY}:${document.querySelector('.shell-topbar__panel')?.scrollTop ?? 0}`;
        let last = position();
        let still = 0;
        const tick = () => {
          const now = position();
          if (now === last) {
            still += 1;
            if (still >= 5) return resolve();
          } else {
            still = 0;
            last = now;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** The heading's box lies inside the viewport: where it is, not only that it exists. */
async function expectHeadingInView(page: Page, id: string): Promise<void> {
  await scrollSettled(page);
  const where = await page.locator(`h2#${id}`).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const covering = document.elementFromPoint(r.left + 4, r.top + r.height / 2);
    return { top: r.top, bottom: r.bottom, vh: window.innerHeight, uncovered: covering !== null && el.contains(covering) };
  });
  expect(where.top, `${id} top`).toBeGreaterThanOrEqual(0);
  expect(where.bottom, `${id} bottom`).toBeLessThanOrEqual(where.vh);
  expect(where.uncovered, `${id} is the element at its own left edge`).toBe(true);
}

const lastProjectKeys = (page: Page) => page.evaluate((p) => Object.keys(localStorage).filter((k) => k.startsWith(p)), PREFIX);

test.afterAll(async () => {
  await testDb.$disconnect();
});

test.describe('Findings from the rail (P2, L2-64 to L2-66)', () => {
  for (const width of [1280, 375] as const) {
    test(`P2 (${width} px): Findings goes to the project last opened, and follows the next one opened without a reload`, async ({ browser }) => {
      const fx = await buildOrg({ label: `fl${width}` });
      const first = await addProject(fx, { name: 'First findings project' });
      const second = await addProject(fx, { name: 'Second findings project' });
      const context = await newContext(browser, { viewport: { width, height: 900 } });
      const page = await context.newPage();
      await signIn(page, fx.members.owner);
      const press = async (name: string) => {
        if (width < 1024) {
          await hydrated(page, '.shell-topbar__menu-button');
          await page.locator('.shell-topbar__menu-button').click();
        }
        await railLink(page, name).click();
      };

      await page.goto(`/orgs/${fx.org.slug}/projects/${first.id}`);
      await hydrated(page, '.shell-rail__signout');
      await expect(railLink(page, 'Findings')).toHaveAttribute('href', `/orgs/${fx.org.slug}/projects?for=findings&last=${first.id}`);
      await press('Findings');
      await page.waitForURL(`**/orgs/${fx.org.slug}/projects/${first.id}/findings`);

      // To the other project by links (client navigation: the shell stays mounted), then Findings again.
      await press('Projects');
      await page.waitForURL((u) => u.pathname === `/orgs/${fx.org.slug}/projects`);
      await page.getByRole('main').getByRole('link', { name: 'Second findings project' }).click();
      await page.waitForURL((u) => u.pathname === `/orgs/${fx.org.slug}/projects/${second.id}`);
      await expect(railLink(page, 'Findings')).toHaveAttribute('href', `/orgs/${fx.org.slug}/projects?for=findings&last=${second.id}`);
      await press('Findings');
      await page.waitForURL(`**/orgs/${fx.org.slug}/projects/${second.id}/findings`);
      await context.close();
    });
  }

  test('L2-66 S4: Sign out through the rail leaves no last-project key on the device', async ({ browser }) => {
    const fx = await buildOrg({ label: 'flout' });
    const p = await addProject(fx, { name: 'Signed-out project' });
    await addProject(fx, { name: 'Other project' });
    const context = await newContext(browser);
    const page = await context.newPage();
    await signIn(page, fx.members.assessor);
    await page.goto(`/orgs/${fx.org.slug}/projects/${p.id}`);
    await hydrated(page, '.shell-rail__signout');
    await expect.poll(() => lastProjectKeys(page)).toEqual([`${PREFIX}${fx.members.assessor.userId}:${fx.org.slug}`]);
    await rail(page).getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL((u) => u.pathname === '/login');
    expect(await lastProjectKeys(page)).toEqual([]);
    await context.close();
  });

  test('S4: a second person on the same browser never uses the first person\'s key; they land on Projects with the line', async ({ browser }) => {
    const fx = await buildOrg({ label: 'fltwo' });
    const p = await addProject(fx, { name: 'First person project' });
    await addProject(fx, { name: 'Another project' });
    const context = await newContext(browser);
    const page = await context.newPage();
    await signIn(page, fx.members.reviewer);
    // The first person's key, as an idle sign-out (which runs no client code) would leave it.
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [`${PREFIX}${fx.members.owner.userId}:${fx.org.slug}`, p.id]);
    await page.goto(`/orgs/${fx.org.slug}/dashboard`);
    await hydrated(page, '.shell-rail__signout');
    // The expected address is also the server's, so give the rail two frames after hydration to read the device first.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await expect(railLink(page, 'Findings')).toHaveAttribute('href', `/orgs/${fx.org.slug}/projects?for=findings`);
    await railLink(page, 'Findings').click();
    await page.waitForURL((u) => u.pathname === `/orgs/${fx.org.slug}/projects` && u.searchParams.get('for') === 'findings');
    await expect(page.getByRole('main').getByText(CHOOSE, { exact: true })).toBeVisible();
    await context.close();
  });

  test('Review Focus 1: with storage blocked, no page error, the rail is whole, the theme switch works, and Findings asks to choose', async ({ browser }) => {
    const fx = await buildOrg({ label: 'flblock' });
    const a = await addProject(fx, { name: 'Blocked A' });
    const b = await addProject(fx, { name: 'Blocked B' });
    const context = await newContext(browser);
    const page = await context.newPage();
    await signIn(page, fx.members.owner);
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/orgs/${fx.org.slug}/projects/${a.id}`);
    await hydrated(page, '.shell-rail__signout');
    // The rail's items (its brand and, on a project's page, the project block are links too: e2e/shell-project.spec.ts).
    await expect(rail(page).locator('a.shell-rail__item')).toHaveText(['Home', 'Projects', 'Findings', 'Guidance', 'Help', 'Members', 'Organisation', 'My account']);
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await rail(page).locator('.shell-theme').click();
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).not.toBe(before);
    await railLink(page, 'Findings').click();
    await page.waitForURL((u) => u.pathname === `/orgs/${fx.org.slug}/projects` && u.searchParams.get('for') === 'findings');
    const main = page.getByRole('main');
    await expect(main.getByText(CHOOSE, { exact: true })).toBeVisible();
    // F6 (b): clear space between the line and the list under it (plan 1B Task 12: one list, no Active heading).
    const below = await page.evaluate((text) => {
      const line = [...document.querySelectorAll('main p')].find((p) => p.textContent === text)!;
      return document.getElementById('projects-list')!.getBoundingClientRect().top - line.getBoundingClientRect().bottom;
    }, CHOOSE);
    expect(below).toBeGreaterThanOrEqual(16);
    for (const p of [a, b]) await expect(main.locator(`a[href="/orgs/${fx.org.slug}/projects/${p.id}/findings"]`)).toHaveCount(1);
    expect(errors).toEqual([]);
    await context.close();
  });

  test('L2-65: an organisation with one project: Findings goes straight to its findings', async ({ browser }) => {
    const fx = await buildOrg({ label: 'flone' });
    const only = await addProject(fx, { name: 'The only project' });
    const context = await newContext(browser);
    const page = await context.newPage();
    await signIn(page, fx.members.viewer);
    await page.goto(`/orgs/${fx.org.slug}/dashboard`);
    await hydrated(page, '.shell-rail__signout');
    await railLink(page, 'Findings').click();
    await page.waitForURL(`**/orgs/${fx.org.slug}/projects/${only.id}/findings`);
    await context.close();
  });

  test('S1 S2: in the address bar, another organisation\'s project or a malformed last gives the same page as no last', async ({ browser }) => {
    const fx = await buildOrg({ label: 'flbar' });
    const other = await buildOrg({ label: 'flbarb' });
    await addProject(fx, { name: 'Bar A' });
    await addProject(fx, { name: 'Bar B' });
    const foreign = await addProject(other, { name: 'Foreign bar project' });
    const context = await newContext(browser);
    const page = await context.newPage();
    await signIn(page, fx.members.owner);
    const mainText = async (query: string) => {
      const res = await page.goto(`/orgs/${fx.org.slug}/projects?${query}`);
      expect(res?.status(), query).toBe(200);
      expect(new URL(page.url()).pathname, query).toBe(`/orgs/${fx.org.slug}/projects`);
      return page.getByRole('main').innerText();
    };
    const plain = await mainText('for=findings');
    expect(plain).toContain(CHOOSE);
    expect(await mainText(`for=findings&last=${foreign.id}`)).toBe(plain);
    expect(await mainText('for=findings&last=not-a-uuid')).toBe(plain);
    await context.close();
  });
});

test.describe('Help, /help (L2-67 to L2-71)', () => {
  test('L2-69 R7: signed out, the public header, the four headings in order, the footer link lands on Terms and privacy in view, Sign in goes to /login', async ({ browser }) => {
    const context = await newContext(browser, { viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('contentinfo').getByRole('link', { name: 'Terms and privacy' }).click();
    await page.waitForURL((u) => u.pathname === '/help' && u.hash === '#terms-and-privacy');
    await expectHeadingInView(page, 'terms-and-privacy');
    await expect(page.locator('.shell-public-header')).toHaveCount(1);
    await expect(page.locator('.shell-rail')).toHaveCount(0);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('main').locator('h2')).toHaveText(['Words used on the platform', 'What sealing means', 'Terms and privacy', 'Contact']);
    // F6 (a): the About link stands apart from Contact by a section's space (48 px), not a paragraph's.
    const aboutGap = await page.evaluate(() => {
      const about = document.querySelector('.help__about')!.getBoundingClientRect().top;
      const contact = document.getElementById('contact')!.parentElement!.getBoundingClientRect().bottom;
      return about - contact;
    });
    expect(aboutGap).toBeGreaterThanOrEqual(48);
    // F6 (b) is on Projects; F6's computed type: the ramp and the body text as globals.css gives them.
    const type = await page.evaluate(() => Object.fromEntries(['.help h1', '.help h2', '.help h3', '.help__list dt', '.help__list dd'].map((s) => {
      const cs = getComputedStyle(document.querySelector(s)!);
      return [s, `${cs.fontSize}/${cs.fontWeight}`];
    })));
    expect(type).toEqual({ '.help h1': '30px/700', '.help h2': '22px/700', '.help h3': '18px/700', '.help__list dt': '16px/600', '.help__list dd': '16px/400' });
    // Where the header sits: above main, its bottom edge at or above main's top.
    const header = await page.locator('.shell-public-header').boundingBox();
    const main = await page.getByRole('main').boundingBox();
    expect(header !== null && main !== null && header.y + header.height <= main.y + 1).toBe(true);
    await page.locator('.shell-public-header').getByRole('link', { name: 'Sign in' }).click();
    await page.waitForURL((u) => u.pathname === '/login');
    await context.close();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`NFR-A11Y: /help signed out has no serious axe violation and no horizontal scroll at 1280, 375 and 320 px (${scheme})`, async ({ browser }) => {
      const context = await newContext(browser, { colorScheme: scheme });
      const page = await context.newPage();
      for (const [w, h] of [[1280, 900], [375, 812], [320, 640]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto('/help');
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `/help signed out ${w}x${h} ${scheme}`);
        // The reading column: no wider than the measure, inside the viewport on both sides.
        const col = await page.locator('.help').boundingBox();
        expect(col !== null && col.x >= 0 && col.x + col.width <= w).toBe(true);
        if (w === 320) {
          // F6: a 40-character address, set in the page in place of today's, still causes no horizontal scroll.
          await page.locator('a.help__address').evaluate((a) => { a.textContent = 'a-much-longer-help-address@makrai.org.ug'; });
          expect(await page.locator('a.help__address').innerText()).toHaveLength(40);
          await expectNoHorizontalScroll(page);
        }
      }
      await context.close();
    });
  }

  test('L2-68 L2-48 S5: as a member, one main, the rail with Help current and nothing else current, and the idle wrapper', async ({ browser }) => {
    const fx = await buildOrg({ label: 'hlpmem' });
    const context = await newContext(browser);
    const page = await context.newPage();
    await signIn(page, fx.members.viewer);
    await page.goto('/help');
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.locator('.shell-public-header')).toHaveCount(0);
    await expect(railLink(page, 'Help')).toHaveAttribute('aria-current', 'page');
    await expect(rail(page).locator('[aria-current="page"]')).toHaveCount(1);
    await expect(page.locator('.shell-idle')).toHaveCount(1);
    await expect(page.getByRole('main').locator('h1')).toHaveText('Help');
    await context.close();
  });

  test('answer (iv): as the MAK-AI administrator, the rail has no Help item and no current item', async ({ browser }) => {
    const context = await browser.newContext({ storageState: adminSeat().storageStatePath });
    const page = await context.newPage();
    await page.goto('/help');
    await expect(rail(page)).toHaveCount(1);
    await expect(railLink(page, 'Help')).toHaveCount(0);
    await expect(rail(page).locator('[aria-current="page"]')).toHaveCount(0);
    await context.close();
  });

  test('L2-70 S5: with a password change due, the public header and no rail; Sign in lands on /change-password', async ({ browser }) => {
    const fx = await buildOrg({ label: 'hlppw' });
    const context = await newContext(browser);
    const page = await context.newPage();
    await signIn(page, fx.members.assessor);
    await testDb.user.update({ where: { id: fx.members.assessor.userId }, data: { mustChangePassword: true } });
    const res = await page.goto('/help');
    expect(res?.status()).toBe(200);
    await expect(page.locator('.shell-public-header')).toHaveCount(1);
    await expect(page.locator('.shell-rail')).toHaveCount(0);
    await expect(page.getByRole('main')).not.toContainText(fx.members.assessor.email);
    await page.locator('.shell-public-header').getByRole('link', { name: 'Sign in' }).click();
    await page.waitForURL((u) => u.pathname === '/change-password');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await context.close();
  });

  test('L2-70 S5: with a text to accept, the public header and no rail; Sign in lands on /acceptances', async ({ browser }) => {
    const fx = await buildOrg({ label: 'hlpacc', acceptances: 'none' });
    const context = await newContext(browser);
    const page = await context.newPage();
    await signIn(page, fx.members.assessor);
    const res = await page.goto('/help');
    expect(res?.status()).toBe(200);
    await expect(page.locator('.shell-public-header')).toHaveCount(1);
    await expect(page.locator('.shell-rail')).toHaveCount(0);
    await page.locator('.shell-public-header').getByRole('link', { name: 'Sign in' }).click();
    await page.waitForURL((u) => u.pathname === '/acceptances');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await context.close();
  });

  test('W2: the review page\'s "What sealing means" link lands on /help#what-sealing-means with that heading in view', async ({ browser }) => {
    const fx = await buildOrg({ label: 'hlpseal' });
    const p = await addProject(fx, { name: 'Sealing project' });
    const review = await addStageReview(fx, p.id, { stage: 'pre-processing' });
    const context = await newContext(browser, { viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await signIn(page, fx.members.owner);
    await page.goto(`/orgs/${fx.org.slug}/projects/${p.id}/reviews/${review.id}`);
    await page.getByRole('main').getByRole('link', { name: 'What sealing means' }).click();
    await page.waitForURL((u) => u.pathname === '/help' && u.hash === '#what-sealing-means');
    await expectHeadingInView(page, 'what-sealing-means');
    await context.close();
  });
});
