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
  check: (page: Page, label: string) => Promise<void>,
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
        await check(page, `${shell.url} ${colorScheme} ${width}`);
      }
    } finally {
      await context.close();
    }
  }
}

/**
 * INTERIM, owned elsewhere (units/UI.md "Stop and report" item 2). The body of /explore/controls (app/(authenticated)/explore/controls/
 * ControlsLibraryPage.css and the control cards) sets its own colours, which fail colour contrast in both themes: grey card text on
 * white, and in the dark theme navy headings on the dark card. The page is rebuilt by CNT and SUG, not by the shell, so the rule is
 * named here and nothing else is let through. The page must still show exactly this finding: when it is fixed, `expectNoSerious...`
 * passes, this fails, and the entry is deleted.
 */
const KNOWN_FINDINGS: Record<string, string> = { '/explore/controls': 'color-contrast' };

async function expectNoViolationsExceptKnown(page: Page, label: string): Promise<void> {
  const known = KNOWN_FINDINGS[new URL(page.url()).pathname];
  if (!known) return expectNoSeriousA11yViolations(page, label);
  const error = await expectNoSeriousA11yViolations(page, label).then(
    () => null,
    (e: Error) => e,
  );
  if (!error) throw new Error(`${label}: the known ${known} finding is gone; delete the entry from KNOWN_FINDINGS in e2e/shell-checks.spec.ts`);
  const rules = [...error.message.matchAll(/^- ([a-z-]+) \(/gm)].map((m) => m[1]);
  expect(rules, `${label}: only the known ${known} finding may remain`).toEqual([known]);
}

test.describe('shell pages, checked with the harness helpers', () => {
  test.setTimeout(3 * 60_000);

  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      test(`UX-32 NFR-A11Y-01: no serious or critical violation in ${scheme} at ${width}`, async ({ browser }) => {
        await onEveryShellPage(browser, scheme, width, (page, label) => expectNoViolationsExceptKnown(page, label));
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
      await page.goto(`/orgs/${slug}/dashboard`);
      const requests = recordRequests(page);
      await page.waitForFunction(() => {
        const d = document.querySelector('dialog.idle-warning');
        return d !== null && Object.keys(d).some((k) => k.startsWith('__reactProps$'));
      });
      // The countdown starts at mount, so a jump made before React hydrated the dialog is counted from the wrong moment.
      await page.waitForTimeout(300);
      // The seat's storage state was signed in minutes ago, so a fixed time no longer lands in the warning window.
      const expires = (await context.cookies()).find((c) => /session-token/.test(c.name))!.expires;
      await page.clock.fastForward(expires * 1000 - Date.now() - 115_000); // 115 s before the cookie's expiry, 10 s inside the window
      await page.clock.runFor(31_000); // two 15 s ticks fire: a tick is a local check, not a request
      await expect(page.getByRole('dialog')).toContainText('You will be signed out in 2 minutes because nothing has happened for a while.', { timeout: 10_000 });
      // Not requests of the warning: the browser's own fetch of the page icons after load, and Next's assets.
      expect(requests.urls().filter((u) => !u.includes('/_next/') && !/\/favicon[^/]*\.png$/.test(u))).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
