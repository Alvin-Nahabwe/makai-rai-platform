import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { addProject, buildOrg, type FixtureAccount, type OrgFixture } from '../__tests__/helpers/recordFixture';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectNoHorizontalScroll } from './helpers/reflow';

/**
 * Stage 1 "Route", lane 3 task 1, in a browser: the rail's logo and project block (owner ruling R4), the narrow top bar's
 * project context, and the footer's two logos.
 *  - The block is in the first HTML of a project page and a question page, with "You are here" on the stage in the
 *    address, and it is GONE after a client-side navigation to Home and to Projects (the `@project` slot's mirror pages;
 *    Next.js keeps a slot's last page otherwise).
 *  - At 375 px the top bar holds the stage and the project and "All questions" to the stage's list.
 *  - The footer's logos show on a signed-in page and on public pages; axe in both themes; no sideways scroll at 320 px.
 * The organisation is this spec's own (record fixture builder); each case signs in on the login page, as
 * e2e/home-next-step.spec.ts does.
 */
const RUN = randomUUID().slice(0, 8);
// 70 characters with one long word: the bar must cut it with an ellipsis, the rail must wrap it.
const LONG_NAME = `Shell ${RUN} Antenatal-risk-triage-for-district-hospitals project`.padEnd(70, 'x').slice(0, 70);

let fx: OrgFixture;
let other: OrgFixture;
let project: { id: string };
let foreign: { id: string };
const contexts: BrowserContext[] = [];
let ipSeq = 0;
const nextClientIp = () => `10.83.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

async function signedIn(browser: Browser, account: Pick<FixtureAccount, 'email' | 'password'>,
  opts: Parameters<Browser['newContext']>[0] = {}): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': nextClientIp() }, ...opts });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
  return page;
}

/** Waits until React has hydrated the element (the shell's links then navigate on the client). */
async function hydrated(page: Page, selector = '.shell-rail__signout'): Promise<void> {
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return el !== null && Object.keys(el).some((k) => k.startsWith('__reactFiber$'));
  }, selector);
}

const projectPath = () => `/orgs/${fx.org.slug}/projects/${project.id}`;
const questionPath = () => `${projectPath()}/stages/pre-processing/questions/Q-PP-01`;
const block = (page: Page) => page.locator('nav.shell-rail .shell-project');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  fx = await buildOrg({ label: 'shellp' });
  other = await buildOrg({ label: 'shello' });
  project = await addProject(fx, { name: LONG_NAME });
  foreign = await addProject(other, { name: `Not yours ${RUN}` });
  // One decision in in-processing, saved through the route with the assessor's own session, so that stage is started.
  const assessor = await signedIn(browser, fx.members.assessor);
  const res = await assessor.context().request.post(`/api/v1/orgs/${fx.org.slug}/projects/${project.id}/decisions`, {
    headers: { origin: new URL(assessor.url()).origin },
    data: {
      requestId: randomUUID(), stage: 'in-processing', questionId: 'Q-IP-02', baseVersionNumber: null, status: 'done', scopeAnswer: null,
      optionsInPlace: [], reasonCode: null, reason: `Seeded reason ${randomUUID()} for this decision.`,
      decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, declaredDate: '2026-10-30', evidenceIds: [],
    },
  });
  if (!res.ok()) throw new Error(`seeding Q-IP-02 answered ${res.status()}: ${await res.text()}`);
});

test.afterAll(async () => {
  await Promise.all(contexts.map((c) => c.close()));
});

test('R4: the rail\'s brand is the MAK-AI logo with the platform\'s name, one link to the organisation\'s Home', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.viewer, { viewport: { width: 1280, height: 800 } });
  await page.goto(`/orgs/${fx.org.slug}/projects`);
  const brand = page.locator('nav.shell-rail a.shell-rail__brand');
  await expect(brand).toBeVisible();
  await expect(brand).toHaveAccessibleName('MAK-AI RAI Platform');
  await expect(brand).toHaveAttribute('href', `/orgs/${fx.org.slug}/dashboard`);
  // The image has loaded and is drawn at its own box (no layout shift: width and height are in the markup).
  const logo = brand.locator('img');
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  expect(await logo.evaluate((img: HTMLImageElement) => [img.width, img.height])).toEqual([154, 36]);
});

test('R4 S1: a project page and a question page carry the block in their first HTML, with "You are here" only on the stage in the address', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.viewer, { viewport: { width: 1280, height: 800 } });
  // The server's HTML, before any script: the block is there (S1).
  const html = await (await page.context().request.get(questionPath())).text();
  expect(html).toContain('class="shell-project"');
  expect(html).toContain('You are here · ');

  await page.goto(projectPath());
  await expect(block(page)).toBeVisible();
  await expect(block(page).locator('.shell-project__name')).toHaveText(LONG_NAME);
  await expect(block(page).locator('[aria-current]')).toHaveCount(0);
  await expect(block(page).getByRole('link', { name: /^In-processing \d+ questions · \d+ no decision yet$/ })).toBeVisible();
  await expect(block(page).getByRole('link', { name: 'Post-processing Not started' })).toBeVisible();

  await page.goto(questionPath());
  const current = block(page).locator('[aria-current="location"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAccessibleName(/^Pre-processing You are here · \d+ questions$/);
  await expect(current).toHaveAttribute('href', `${projectPath()}/stages/pre-processing`);
  await expect(page.locator('body')).not.toContainText('%');
});

test('R4: after a client-side navigation to Home and to Projects the block is gone; back to the question, it returns', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.viewer, { viewport: { width: 1280, height: 800 } });
  await page.goto(questionPath());
  await hydrated(page);
  await expect(block(page)).toBeVisible();
  // A marker on the window survives only a client-side navigation: a full load would clear it.
  await page.evaluate(() => { (window as unknown as { shellMarker: string }).shellMarker = 'kept'; });
  const marker = () => page.evaluate(() => (window as unknown as { shellMarker?: string }).shellMarker);

  await page.locator('nav.shell-rail .shell-rail__item', { hasText: 'Home' }).click();
  await page.waitForURL(`**/orgs/${fx.org.slug}/dashboard`);
  await expect(block(page)).toHaveCount(0);
  await expect(page.locator('.shell-bar-project')).toHaveCount(0);
  expect(await marker()).toBe('kept');

  await page.goBack();
  await page.waitForURL(`**${questionPath()}`);
  await expect(block(page).locator('[aria-current="location"]')).toHaveAccessibleName(/^Pre-processing You are here/);

  await page.locator('nav.shell-rail .shell-rail__item', { hasText: 'Projects' }).click();
  await page.waitForURL(`**/orgs/${fx.org.slug}/projects`);
  await expect(block(page)).toHaveCount(0);
  expect(await marker()).toBe('kept');
});

test('R4: a stage link in the block moves "You are here" to that stage on a client-side navigation', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.viewer, { viewport: { width: 1280, height: 800 } });
  await page.goto(questionPath());
  await hydrated(page);
  await block(page).getByRole('link', { name: /^Post-processing / }).click();
  await page.waitForURL(`**${projectPath()}/stages/post-processing`);
  await expect(block(page).locator('[aria-current="location"]')).toHaveAccessibleName(/^Post-processing You are here/);
  await expect(block(page).getByRole('link', { name: 'Pre-processing Not started' })).toBeVisible();
});

test('S2: another organisation\'s project, an unknown id and a malformed id show no block and no project words', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner, { viewport: { width: 1280, height: 800 } });
  for (const path of [
    `/orgs/${fx.org.slug}/projects/${foreign.id}`, `/orgs/${fx.org.slug}/projects/${randomUUID()}/stages/pre-processing`,
    `/orgs/${fx.org.slug}/projects/not-a-uuid`, `/orgs/${other.org.slug}/projects/${foreign.id}`,
  ]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
    await expect(page.locator('.shell-project, .shell-bar-project'), path).toHaveCount(0);
    expect(await page.content(), path).not.toContain(`Not yours ${RUN}`);
  }
});

test('the narrow top bar: the stage and the project, and "All questions" to the stage\'s list; the project alone on its page', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.viewer, { viewport: { width: 375, height: 812 } });
  await page.goto(questionPath());
  const bar = page.locator('header.shell-topbar');
  await expect(bar.locator('.shell-bar-project__stage')).toHaveText('Pre-processing');
  await expect(bar.locator('.shell-bar-project__name')).toHaveText(LONG_NAME);
  // Cut with an ellipsis, not wrapped: one line, narrower than its text.
  expect(await bar.locator('.shell-bar-project__name').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const all = bar.getByRole('link', { name: 'All questions' });
  await expect(all).toBeVisible();
  await expect(all).toHaveAttribute('href', `${projectPath()}/stages/pre-processing`);
  // The logo makes room for the project context.
  await expect(bar.locator('.shell-topbar__brand')).toBeHidden();
  await expectNoHorizontalScroll(page);

  await page.goto(projectPath());
  await expect(bar.locator('.shell-bar-project__stage')).toHaveCount(0);
  await expect(bar.locator('.shell-bar-project__name')).toHaveText(LONG_NAME);
  await expect(bar.getByRole('link', { name: 'All questions' })).toHaveCount(0);

  await page.goto(`/orgs/${fx.org.slug}/dashboard`);
  await expect(bar.locator('.shell-topbar__brand')).toBeVisible();
  await expect(bar.locator('.shell-topbar__brand')).toHaveAccessibleName('MAK-AI RAI Platform');
});

test('reflow: no sideways scroll at 320 px on a question page, a project page and Home, the Menu panel open too', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.viewer, { viewport: { width: 320, height: 640 } });
  for (const path of [questionPath(), projectPath(), `/orgs/${fx.org.slug}/dashboard`]) {
    await page.goto(path);
    await expectNoHorizontalScroll(page);
  }
  await page.goto(questionPath());
  await hydrated(page, '.shell-topbar__menu-button');
  await page.locator('.shell-topbar__menu-button').click();
  await expect(page.locator('.shell-topbar__panel .shell-project')).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('one gutter round the page (fix round 2): each signed-in page\'s content starts 16 px in at 375 and 32 px at 1280', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.owner, { viewport: { width: 375, height: 812 } });
  const paths = [
    `/orgs/${fx.org.slug}/dashboard`, `/orgs/${fx.org.slug}/projects`, projectPath(), questionPath(),
    `/orgs/${fx.org.slug}/settings/members`, '/help', '/account',
  ];
  for (const [width, gutter] of [[375, 16], [1280, 32]] as const) {
    await page.setViewportSize({ width, height: 812 });
    for (const path of paths) {
      await page.goto(path);
      // The shell's main gives the gutter; the page's own root (.page-content, or Help's .help) adds no inline or top
      // padding of its own, and starts at main's content edge.
      const at = await page.evaluate(() => {
        const main = document.querySelector('main#main-content') as HTMLElement;
        const root = main.querySelector(':scope > .page-content, :scope > .help') as HTMLElement | null;
        const ms = getComputedStyle(main);
        if (root === null) return null;
        const rs = getComputedStyle(root);
        return {
          main: [parseFloat(ms.paddingLeft), parseFloat(ms.paddingTop)],
          root: [parseFloat(rs.paddingLeft), parseFloat(rs.paddingTop)],
          top: Math.round(root.getBoundingClientRect().top - main.getBoundingClientRect().top),
        };
      });
      expect(at, `${path}: a .page-content or .help root`).not.toBeNull();
      expect(at!.main, `${path} at ${width}: main's padding is the gutter`).toEqual([gutter, gutter]);
      expect(at!.root, `${path} at ${width}: the page root adds none`).toEqual([0, 0]);
      expect(at!.top, `${path} at ${width}: content starts one gutter down`).toBe(gutter);
    }
  }
});

test('the shell leaves the question page\'s Save row as it is (fix round 3): fixed to the foot at 375; main the scroller at 1280', async ({ browser }) => {
  const page = await signedIn(browser, fx.members.assessor, { viewport: { width: 375, height: 812 } });
  await page.goto(questionPath());
  const bar = page.locator('.decision-save-bar');
  await expect(bar).toBeVisible();
  const foot = () => bar.evaluate((el) => Math.round(el.getBoundingClientRect().bottom - window.innerHeight));
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  expect(await foot(), 'the row sits on the screen\'s foot').toBe(0);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
  await page.waitForFunction(() => window.scrollY > 0);
  expect(await foot(), 'and stays there while the content scrolls').toBe(0);

  // From 1024 px the shell's main is the content's scroller, with its 32 px padding: the frame lane 2's pinned Save row
  // (sticky, its inset taking main's padding back) is built against. The shell keeps it.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(questionPath());
  const main = await page.evaluate(() => {
    const m = document.querySelector('main#main-content') as HTMLElement;
    const cs = getComputedStyle(m);
    return { overflowY: cs.overflowY, maxHeight: cs.maxHeight, padBottom: cs.paddingBottom, vh: window.innerHeight,
      holdsRow: m.contains(document.querySelector('.decision-save-bar')) };
  });
  expect(main).toEqual({ overflowY: 'auto', maxHeight: `${main.vh}px`, padBottom: '32px', vh: main.vh, holdsRow: true });
});

for (const [width, height] of [[1366, 768], [1280, 800], [1440, 900]] as const) {
  test(`D4 D5 (fix round 3): at ${width}x${height} the rail's foot is whole in the first view, and an overflowing upper part shows a cue`, async ({ browser }) => {
    const page = await signedIn(browser, fx.members.viewer, { viewport: { width, height } });
    for (const path of [questionPath(), projectPath(), `/orgs/${fx.org.slug}/dashboard`]) {
      await page.goto(path);
      await hydrated(page);
      const foot = page.locator('.shell-rail__foot');
      for (const part of [foot.locator('.shell-rail__person'), foot.getByRole('link', { name: 'My account' }),
        foot.getByRole('button', { name: 'Sign out' }), foot.locator('.shell-theme')]) {
        const b = (await part.boundingBox())!;
        expect(b.y + b.height, `${path} at ${width}x${height}: the foot is in the first view`).toBeLessThanOrEqual(height + 0.5);
      }
      for (const control of [foot.getByRole('link', { name: 'My account' }), foot.getByRole('button', { name: 'Sign out' })]) {
        expect((await control.boundingBox())!.height, 'a 44 px target').toBeGreaterThanOrEqual(44);
      }
      const scroller = page.locator('.shell-rail__scroll');
      expect(await scroller.evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe('thin');
      const overflowing = await scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
      const cue = (which: '::before' | '::after') => scroller.evaluate((el, w) => Number(getComputedStyle(el, w).opacity), which);
      if (overflowing) {
        await expect.poll(() => cue('::after'), `${path}: more below, so the bottom cue shows`).toBeGreaterThan(0.5);
        await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await expect.poll(() => cue('::before'), `${path}: more above, so the top cue shows`).toBeGreaterThan(0.5);
        await expect.poll(() => cue('::after'), `${path}: nothing below, so no bottom cue`).toBeLessThan(0.5);
      } else {
        expect(await cue('::after'), `${path}: nothing hidden, no cue`).toBeLessThan(0.5);
      }
    }
  });
}

test('the footer: both logos, named, on a signed-in page and on the public pages', async ({ browser }) => {
  const check = async (page: Page, where: string) => {
    const footer = page.locator('footer.shell-footer');
    await footer.scrollIntoViewIfNeeded();
    for (const name of ['MAK-AI', 'Data Science Without Borders']) {
      const img = footer.getByRole('img', { name, exact: true });
      await expect(img, `${where}: ${name}`).toBeVisible();
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), `${where}: ${name} loaded`).toBe(true);
    }
    await expect(footer.getByRole('navigation', { name: 'Footer' }).getByRole('link'))
      .toHaveText(['CC BY-SA 4.0', 'Terms and privacy', 'About', 'Help and contact']);
  };
  const page = await signedIn(browser, fx.members.viewer, { viewport: { width: 1280, height: 800 } });
  await page.goto(projectPath());
  await check(page, 'project page');
  const out = await browser.newContext({ viewport: { width: 375, height: 812 } });
  contexts.push(out);
  const pub = await out.newPage();
  for (const path of ['/login', '/about']) {
    await pub.goto(path);
    await check(pub, path);
    await expectNoHorizontalScroll(pub);
  }
});

test('axe finds nothing serious in light or dark: the block at 1280 px, the bar at 375 px closed and open, a public page', async ({ browser }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const page = await signedIn(browser, fx.members.viewer, { colorScheme, viewport: { width: 1280, height: 800 } });
    await page.goto(questionPath());
    await hydrated(page);
    await expectNoSeriousA11yViolations(page, `question 1280 ${colorScheme}`);
    await page.setViewportSize({ width: 375, height: 700 });
    await expectNoSeriousA11yViolations(page, `question 375 closed ${colorScheme}`);
    await page.locator('.shell-topbar__menu-button').click();
    await expect(page.locator('.shell-topbar__panel')).toBeVisible();
    await expectNoSeriousA11yViolations(page, `question 375 open ${colorScheme}`);
    const out = await browser.newContext({ colorScheme, viewport: { width: 1280, height: 800 } });
    contexts.push(out);
    const pub = await out.newPage();
    await pub.goto('/login');
    await pub.locator('footer.shell-footer').scrollIntoViewIfNeeded();
    await expectNoSeriousA11yViolations(pub, `login ${colorScheme}`);
  }
});
