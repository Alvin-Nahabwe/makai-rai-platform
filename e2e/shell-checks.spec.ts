import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectTargetsAtLeast24px } from './helpers/targetSize';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { recordRequests } from './helpers/requests';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { abortPendingBackgroundRequests } from './helpers/pendingLinks';

/**
 * The shell pages (Task U1) checked with the harness helpers: axe in both themes at 1280 and 360, target size at 360,
 * reflow at 320 by 640 (UX-32, UX-34, UX-35), no image but the logo and hidden icons (UX-41), a visible focus outline on a
 * form field (UX-33), and no request from the idle warning while it waits (UX-43, NFR-PERF-05).
 *
 * The pages are three signed-out ones (/login, /about, /no-such-page, which is S-31) and five an owner seat reaches.
 */

const SCHEMES = ['light', 'dark'] as const;
const WIDTHS = [1280, 360] as const;

function manifest(): FixtureManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as FixtureManifest;
}

function ownerSeat(): { slug: string; seat: FixtureManifestUser } {
  const m = manifest();
  const slug = m.orgs[0].slug;
  const seat = m.users.find((u) => u.orgSlug === slug && u.role === 'owner' && u.index === 0);
  if (!seat) throw new Error(`shell-checks.spec: no owner seat for ${slug}`);
  return { slug, seat };
}

type ShellPage = { url: string; signedIn: boolean };

function shellPages(slug: string): ShellPage[] {
  return [
    { url: '/login', signedIn: false },
    { url: '/about', signedIn: false },
    { url: '/no-such-page', signedIn: false },
    { url: '/', signedIn: true },
    { url: `/orgs/${slug}/dashboard`, signedIn: true },
    { url: `/orgs/${slug}/projects`, signedIn: true },
    { url: '/explore/framework', signedIn: true },
    { url: '/explore/controls', signedIn: true },
  ];
}

/** A context for signed-out or signed-in pages. Prefetches of pending shell links never settle in a production build, so they are aborted. */
async function contextFor(browser: Browser, signedIn: boolean, colorScheme: 'light' | 'dark', width: number, height = 800): Promise<BrowserContext> {
  const context = await browser.newContext({
    colorScheme,
    viewport: { width, height },
    ...(signedIn ? { storageState: ownerSeat().seat.storageStatePath } : {}),
  });
  await abortPendingBackgroundRequests(context);
  return context;
}

/** Runs `check` on every shell page, signed in or out as the page needs, in one context per kind. */
async function onEveryShellPage(
  browser: Browser,
  colorScheme: 'light' | 'dark',
  width: number,
  check: (page: Page, label: string, colorScheme: 'light' | 'dark') => Promise<void>,
  height = 800,
): Promise<void> {
  const pages = shellPages(ownerSeat().slug);
  for (const signedIn of [false, true]) {
    const context = await contextFor(browser, signedIn, colorScheme, width, height);
    try {
      const page = await context.newPage();
      for (const shell of pages.filter((p) => p.signedIn === signedIn)) {
        await page.goto(shell.url);
        await page.waitForLoadState('networkidle');
        await check(page, `${shell.url} ${colorScheme} ${width}`, colorScheme);
      }
    } finally {
      await context.close();
    }
  }
}

/**
 * INTERIM, owned elsewhere (units/UI.md "Stop and report" item 2): colour-contrast findings inside the bodies of pages another unit
 * builds, which the shell cannot fix. The allowance is tight: every failing node of the named rule must sit inside the owner's own
 * container (found with `closest`, so a node in the sidebar, header or footer never matches), and any
 * other rule fails. An entry also fails when its finding is gone, and the allowance is off at the release candidate
 * (RELEASE_CANDIDATE=1), where the full axe check applies.
 *   - the organisation dashboard and projects list, owner PRJ (the project cards): stat labels fail in the light theme. The cards
 *     exist only when the organisation has projects, which earlier specs of a full run create, so the finding is required only
 *     in light and only when a card is on the page.
 */
type KnownFinding = { owner: string; path: RegExp; rule: string; container: string; cardSelector: string; requiredIn: 'light' | 'both' };
const KNOWN_FINDINGS: KnownFinding[] = [
];

const RELEASE_CANDIDATE = process.env.RELEASE_CANDIDATE === '1';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Every serious or critical violation with each failing node's target (the helper's message keeps five) and whether the node sits inside `container`. */
async function blockingViolations(page: Page, container: string): Promise<Array<{ id: string; nodes: Array<{ target: string; inside: boolean }> }>> {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  return page.evaluate(
    async ({ tags, container }) => {
      const axe = (window as unknown as { axe: { run(ctx: Document, opts: object): Promise<{ violations: Array<{ id: string; impact?: string | null; nodes: Array<{ target: unknown[] }> }> }> } }).axe;
      const { violations } = await axe.run(document, { runOnly: { type: 'tag', values: tags } });
      return violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => {
            const target = n.target.map(String).join(' ');
            let el: Element | null = null;
            try {
              el = n.target.length === 1 ? document.querySelector(String(n.target[0])) : null;
            } catch {
              el = null;
            }
            return { target, inside: el !== null && el.closest(container) !== null };
          }),
        }));
    },
    { tags: AXE_TAGS, container },
  );
}

async function expectNoViolationsExceptKnown(page: Page, label: string, colorScheme: 'light' | 'dark'): Promise<void> {
  const known = KNOWN_FINDINGS.find((k) => k.path.test(new URL(page.url()).pathname));
  if (!known || RELEASE_CANDIDATE) return expectNoSeriousA11yViolations(page, label);
  const found = await blockingViolations(page, known.container);
  const others = found.filter((v) => v.id !== known.rule);
  expect(others.map((v) => `${v.id} at ${v.nodes.slice(0, 3).map((n) => n.target).join(' | ')}`), `${label}: only ${known.owner}'s ${known.rule} finding may remain`).toEqual([]);
  const nodes = found.filter((v) => v.id === known.rule).flatMap((v) => v.nodes);
  expect(nodes.filter((n) => !n.inside).map((n) => n.target).slice(0, 5), `${label}: ${known.rule} failures outside ${known.owner}'s own part of the page`).toEqual([]);
  if (known.requiredIn === 'both') {
    expect(await page.locator(known.cardSelector).count(), `${label}: ${known.owner}'s container ${known.cardSelector} is gone; update or delete its entry in KNOWN_FINDINGS`).toBeGreaterThan(0);
  }
  const mustShow = known.requiredIn === 'both' || colorScheme === 'light';
  if (mustShow && nodes.length === 0 && (await page.locator(known.cardSelector).count()) > 0) {
    throw new Error(`${label}: ${known.owner}'s ${known.rule} finding is gone; delete its entry from KNOWN_FINDINGS in e2e/shell-checks.spec.ts`);
  }
}

test.describe('shell pages, checked with the harness helpers', () => {
  test.setTimeout(3 * 60_000);

  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      test(`UX-32 NFR-A11Y-01: no serious or critical violation in ${scheme} at ${width}`, async ({ browser }) => {
        await onEveryShellPage(browser, scheme, width, (page, label, colorScheme) => expectNoViolationsExceptKnown(page, label, colorScheme));
      });
    }
  }

  for (const scheme of SCHEMES) {
    test(`UX-34 NFR-A11Y-04: every target is at least 24 by 24 pixels at 360 in ${scheme}`, async ({ browser }) => {
      await onEveryShellPage(browser, scheme, 360, async (page) => expectTargetsAtLeast24px(page));
    });

    test(`UX-35 NFR-A11Y-05: no horizontal scrolling at 320 by 640 in ${scheme}`, async ({ browser }) => {
      await onEveryShellPage(browser, scheme, 320, async (page) => expectNoHorizontalScroll(page), 640);
    });
  }

  test('UX-41: no image but the logo, and every icon hidden from assistive technology', async ({ browser }) => {
    await onEveryShellPage(browser, 'light', 1280, async (page, label) => {
      const images = await page.locator('img').evaluateAll((els) => els.map((e) => e.getAttribute('alt')));
      expect(images.filter((alt) => alt !== 'MAK-AI'), `${label}: images other than the logo`).toEqual([]);
      const exposed = await page
        .locator('svg:not([aria-hidden="true"]), .icon:not([aria-hidden="true"])')
        // The Next.js development indicator is not part of the product and exists only under `next dev`.
        .evaluateAll((els) => els.filter((e) => !e.closest('[data-nextjs-dev-tools-button], nextjs-portal')).map((e) => `${e.tagName.toLowerCase()}.${e.getAttribute('class') ?? ''}`));
      expect(exposed, `${label}: icons without aria-hidden="true"`).toEqual([]);
    });
  });

  test('UX-33 NFR-A11Y-02: a focused form field has a visible focus outline', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').focus();
    await expectFocusVisibleAndUncovered(page);
  });

  test('UX-43 NFR-PERF-05: the idle warning sends no request while waiting', async ({ browser }) => {
    const { slug, seat } = ownerSeat();
    const context = await browser.newContext({ storageState: seat.storageStatePath });
    try {
      const page = await context.newPage();
      await page.clock.install();
      // Recording starts before the page loads, so a request the warning sends while the page mounts is seen too.
      const requests = recordRequests(page);
      const prefetches = new Set<string>();
      page.on('request', (r) => {
        if (r.headers()['next-router-prefetch'] || r.headers()['purpose'] === 'prefetch') prefetches.add(r.url());
      });
      await page.goto(`/orgs/${slug}/dashboard`);
      expect(requests.urls().some((u) => u.endsWith(`/orgs/${slug}/dashboard`)), 'the recording holds the page itself').toBe(true);
      await page.waitForFunction(() => {
        const d = document.querySelector('.shell-idle dialog.ui-dialog');
        return d !== null && Object.keys(d).some((k) => k.startsWith('__reactProps$'));
      });
      // The countdown starts at mount, so a jump made before React hydrated the dialog is counted from the wrong moment.
      await page.waitForTimeout(300);
      // The seat's storage state was signed in minutes ago, so a fixed time no longer lands in the warning window.
      const expires = (await context.cookies()).find((c) => /session-token/.test(c.name))!.expires;
      await page.clock.fastForward(expires * 1000 - Date.now() - 115_000); // 115 s before the cookie's expiry, 10 s inside the window
      await page.clock.runFor(31_000); // two 15 s ticks fire: a tick is a local check, not a request
      await expect(page.getByRole('dialog')).toContainText('You will be signed out in 2 minutes because nothing has happened for a while.', { timeout: 10_000 });
      // Not requests of the warning: the page itself, Next's assets, the browser's own fetch of the page icons, and the Link
      // prefetches (marked by the router's own header) the rail's links make in a production build when they come into view.
      // A server refresh or any API call from the warning would be left in the list.
      // The page's own address is dropped once only: a second request for it (a reload) stays in the list.
      const own = `/orgs/${slug}/dashboard`;
      const urls = requests.urls();
      const ownIndex = urls.findIndex((u) => u.endsWith(own));
      const left = urls.filter((u, i) => i !== ownIndex && !u.includes('/_next/') && !prefetches.has(u) && !/\/favicon[^/]*\.png$/.test(u));
      expect(left).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
