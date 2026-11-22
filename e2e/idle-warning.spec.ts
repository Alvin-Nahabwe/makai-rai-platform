import { test, expect, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import fs from 'node:fs';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';
import { NOT_FOUND_COPY } from '../lib/errors/not-found/copy';
import { IDLE_TEXTS } from '../lib/auth/session/copy';
import { AUTH_COPY } from '../lib/auth/copy';
import { closeOpenedContexts } from './helpers/contexts';

// Every context a test opened is closed after it (helpers/contexts.ts says why).
test.afterEach(closeOpenedContexts);

/**
 * UX-43 (SRS 7.6.1, line 2645; WCAG 2.2.1): two minutes before the session cookie's expiry the
 * page warns, "Stay signed in" extends the session, and ignoring the warning leaves the page as it
 * is. The warning follows the cookie's own expiry, which only sign-in and a read of
 * GET /api/auth/session move (reviews/fix-r11.md R11-1), not page load or page activity (owner
 * default B33).
 *
 * Cases 1 to 10 run on the normal 12-hour server. page.clock moves only the page's own timers and
 * Date, so no cookie or server clock changes: `toBefore` puts the page's clock a given number of
 * seconds before the cookie's `expires`. The two last cases run only on a server started with the
 * seam, MAKRAI_TEST_SEAMS=1 MAKRAI_TEST_IDLE_SECONDS=180, because the cookie and the server's
 * check use real time; they sign in on the /login form, because the setup project's sessions are
 * older than 180 s by then. The warning counts the deadline 5 s early, so the cases leave 10 s of
 * room and every assertion about the dialog retries for 10 s.
 *
 * The obligation that the warning sends no request while waiting (U-S7) is also in
 * e2e/shell-checks.spec.ts, with the harness helpers.
 */

const WARNING = IDLE_TEXTS.warningTitle;
const FAILED = IDLE_TEXTS.stayFailed;
/** Every signed-out notice says this, whatever the reason (plan 1B Task 4). */
const ENDED = IDLE_TEXTS.endedKept;
const SEAM_RUN = process.env.MAKRAI_TEST_IDLE_SECONDS === '180';
const SHORT = { timeout: 10_000 };

function ownerSeat(): { slug: string; otherSlug: string; seat: FixtureManifestUser } {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as FixtureManifest;
  const slug = manifest.orgs[0].slug;
  const seat = manifest.users.find((u) => u.orgSlug === slug && u.role === 'owner' && u.index === 0);
  if (!seat) throw new Error(`idle-warning.spec: no owner seat for ${slug}`);
  return { slug, otherSlug: manifest.orgs[1].slug, seat };
}

async function ownerPage(browser: Browser) {
  const { slug, otherSlug, seat } = ownerSeat();
  const context = await browser.newContext({ storageState: seat.storageStatePath });
  return { slug, otherSlug, context, page: await context.newPage() };
}

/** The session cookie's `expires`, in seconds. */
async function expiry(context: BrowserContext): Promise<number> {
  return (await context.cookies()).find((c) => /session-token/.test(c.name))?.expires ?? 0;
}

/** Milliseconds to fast-forward so the page's clock reads `s` seconds before `expirySeconds`. Read from the page's own clock. */
async function toBefore(page: Page, expirySeconds: number, s: number): Promise<number> {
  return expirySeconds * 1000 - (await page.evaluate(() => Date.now())) - s * 1000;
}

/** Puts the page 135 s and then 115 s before the cookie's expiry: 130 s and then 110 s with the 5 s margin. */
async function reachWarning(page: Page, context: BrowserContext): Promise<number> {
  const before = await expiry(context);
  expect(before).toBeGreaterThan(0);
  await page.clock.fastForward(await toBefore(page, before, 135));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.clock.fastForward(20_000);
  await expect(page.getByRole('dialog')).toContainText(WARNING, SHORT);
  return before;
}

/**
 * Opens a signed-in page and waits until React has hydrated the idle dialog and had time to run its
 * effects. The warning counts from the moment it mounts, so a clock jump made before that would be
 * counted from the wrong moment (the countdown would start after the jump, not before it).
 */
async function open(page: Page, url: string) {
  const response = await page.goto(url);
  await page.waitForFunction(() => {
    const dialog = document.querySelector('.shell-idle dialog.ui-dialog');
    return dialog !== null && Object.keys(dialog).some((key) => key.startsWith('__reactProps$'));
  });
  await page.waitForTimeout(300);
  return response;
}

/**
 * Moves the page's clock `ms` forward without firing any timer, as a sleeping machine does. It is not
 * `clock.fastForward`: Playwright fakes AbortSignal.timeout on the same clock, so a fast-forward of
 * more than 30 s aborts a read that is being held on purpose and the case would test the abort and
 * not the answer. The warning's 15 s tick then finds the new time, as it does after a real sleep.
 */
async function jumpPastTimers(page: Page, ms: number) {
  await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + ms);
  await page.clock.runFor(16_000);
}

/** Counts the page's requests to GET /api/auth/session. */
function countSessionReads(page: Page): string[] {
  const reads: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/auth/session') reads.push(r.method());
  });
  return reads;
}

const stayButton = (page: Page) => page.getByRole('button', { name: IDLE_TEXTS.stay });

test.describe('idle-sign-out warning on the 12-hour server', () => {
  test.skip(SEAM_RUN, 'the setup project signs the seats in, and with a 180 s limit those sessions end before these cases run');

  test("UX-43: the warning follows the session cookie's expiry, not the page load", async ({ browser }) => {
    const { slug, context, page } = await ownerPage(browser);
    try {
      await page.clock.install();
      await open(page, `/orgs/${slug}/dashboard`);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const before = await expiry(context);
      await page.clock.fastForward(await toBefore(page, before, 135));
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.clock.fastForward(20_000);
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText(WARNING, SHORT);
      await expect(stayButton(page)).toBeFocused();
      // A modal dialog sits in the middle of the window. The page's reset of margins once left it in the top-left corner,
      // where it covered the rail's first items and read as a stray box.
      const box = (await dialog.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(Math.abs(box.x + box.width / 2 - viewport.width / 2), 'horizontal centre').toBeLessThanOrEqual(2);
      expect(Math.abs(box.y + box.height / 2 - viewport.height / 2), 'vertical centre').toBeLessThanOrEqual(2);
      const seconds = Number(await page.locator('.shell-idle').getAttribute('data-seconds-left'));
      expect(Number.isInteger(seconds) && seconds > 0 && seconds <= 43200, String(seconds)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test('UX-43: a clock jump with no timer fired still warns at the next tick', async ({ browser }) => {
    // A sleeping laptop stops timers; when it wakes, Date has moved and nothing has fired.
    const { slug, context, page } = await ownerPage(browser);
    try {
      await page.clock.install();
      await open(page, `/orgs/${slug}/dashboard`);
      const before = await expiry(context);
      await page.clock.setSystemTime(before * 1000 - 100_000);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.clock.runFor(16_000);
      await expect(page.getByRole('dialog')).toContainText(WARNING, SHORT);
      await page.clock.setSystemTime(before * 1000 + 10_000);
      await page.clock.runFor(16_000);
      await expect(page.getByRole('dialog')).toHaveCount(0, SHORT);
    } finally {
      await context.close();
    }
  });

  test('UX-43: Stay signed in extends the session', async ({ browser }) => {
    const { slug, context, page } = await ownerPage(browser);
    try {
      await page.clock.install();
      await open(page, `/orgs/${slug}/dashboard`);
      const before = await reachWarning(page, context);
      // Real time still runs on the server, so wait a moment for the new expiry to differ.
      await page.waitForTimeout(1500);
      const reads = countSessionReads(page);
      await stayButton(page).click();
      await expect(page.getByRole('dialog')).toHaveCount(0, SHORT);
      expect(reads).toEqual(['GET']);
      const after = await expiry(context);
      expect(after).toBeGreaterThan(before);
      // The page's clock and the server's now disagree by hours, so the new deadline is counted from the extension:
      // a full 12 hours less the 5 s margin, with the warning 120 s before that.
      await page.clock.fastForward(43_000_000);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.clock.fastForward(85_000);
      await expect(page.getByRole('dialog')).toContainText(WARNING, SHORT);
    } finally {
      await context.close();
    }
  });

  test('UX-43: Esc on the warning keeps the session like Stay signed in', async ({ browser }) => {
    const { slug, context, page } = await ownerPage(browser);
    try {
      await page.clock.install();
      await open(page, `/orgs/${slug}/dashboard`);
      const before = await reachWarning(page, context);
      await page.waitForTimeout(1500);
      const reads = countSessionReads(page);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0, SHORT);
      await expect.poll(async () => expiry(context), SHORT).toBeGreaterThan(before);
      expect(reads).toEqual(['GET']);
    } finally {
      await context.close();
    }
  });

  test('UX-43: Stay signed in on an ended session closes the dialog and leaves the page usable', async ({ browser }) => {
    // The modal closes and a non-modal notice takes its place, so a mouse or touch user can still select
    // and copy unsaved text. Nothing is navigated, stored or purged (SignOutWithDraftsGuard stays the only purge path).
    const { slug, context, page } = await ownerPage(browser);
    try {
      const path = `/orgs/${slug}/projects/new`;
      await page.clock.install();
      await open(page, path);
      const typed = 'Draft that must survive';
      const field = page.locator('main input[type="text"], main textarea').first();
      await field.fill(typed);
      await page.evaluate(() => localStorage.setItem('idle-test-key', 'kept'));
      await reachWarning(page, context);

      await context.clearCookies();
      const reads = countSessionReads(page);
      await stayButton(page).click(); // the endpoint answers a JSON null
      await expect(page.getByRole('dialog')).toHaveCount(0, SHORT);

      const notice = page.getByRole('alert').filter({ hasText: ENDED });
      await expect(notice).toBeVisible(SHORT);
      // The server ended it before the deadline (the cookies were cleared): the clock cannot say why, so no reason is given.
      await expect(notice).toHaveText(`${IDLE_TEXTS.endedElsewhere} ${ENDED}${IDLE_TEXTS.signInAgain}`);
      const link = notice.getByRole('link', { name: IDLE_TEXTS.signInAgain });
      await expect(link).toHaveAttribute('href', `/login?callbackUrl=${encodeURIComponent(path)}`);
      expect(page.url()).toContain(path);
      expect(await field.inputValue()).toBe(typed);
      expect(await page.evaluate(() => localStorage.getItem('idle-test-key'))).toBe('kept');

      // The page is not inert: a mouse can focus the field and select its text, which an inert page refuses.
      expect(await page.evaluate(() => document.querySelector('main')?.closest('[inert]') !== null)).toBe(false);
      await field.click({ clickCount: 3, timeout: 5_000 });
      await expect(field).toBeFocused();
      expect(await field.evaluate((el: HTMLInputElement | HTMLTextAreaElement) => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0))).toBe(typed);

      // Nothing more is sent, whether the person presses Escape or waits.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
      expect(reads).toHaveLength(1);

      await link.click();
      await expect(page).toHaveURL((url) => url.pathname === '/login' && url.searchParams.get('callbackUrl') === path);
    } finally {
      await context.close();
    }
  });

  for (const variant of [
    { name: 'a 503', respond: (route: Route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"x"}' }) },
    { name: 'a 429', respond: (route: Route) => route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"x"}' }) },
    { name: 'an aborted request', respond: (route: Route) => route.abort() },
    { name: 'a captive-portal page', respond: (route: Route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>portal</html>' }) },
  ]) {
    test(`UX-43: a failed session read (${variant.name}) keeps the warning open and does not retry`, async ({ browser }) => {
      const { slug, context, page } = await ownerPage(browser);
      try {
        await page.clock.install();
        await open(page, `/orgs/${slug}/dashboard`);
        const before = await reachWarning(page, context);
        await page.route('**/api/auth/session', variant.respond);
        const reads = countSessionReads(page);
        await stayButton(page).click();
        await expect(page.getByRole('alert').filter({ hasText: FAILED })).toHaveText(FAILED, SHORT);
        await expect(page.getByRole('dialog')).toBeVisible();
        await expect(stayButton(page)).toBeEnabled();
        expect(reads).toHaveLength(1);
        await page.waitForTimeout(2000);
        expect(reads).toHaveLength(1); // no automatic retry
        await expect(page.getByText(ENDED)).toHaveCount(0); // never read as a signed-out session

        await page.unroute('**/api/auth/session');
        await page.waitForTimeout(1500);
        await stayButton(page).click();
        await expect(page.getByRole('dialog')).toHaveCount(0, SHORT);
        expect(await expiry(context)).toBeGreaterThan(before);
      } finally {
        await context.close();
      }
    });
  }

  test('UX-43: a failed read that settles after the deadline leaves the dialog closed and is read as signed out', async ({ browser }) => {
    const { slug, context, page } = await ownerPage(browser);
    try {
      await page.clock.install();
      await open(page, `/orgs/${slug}/dashboard`);
      await reachWarning(page, context);
      let held: Route | undefined;
      await page.route('**/api/auth/session', (route) => {
        held = route;
      });
      await stayButton(page).click();
      // While the read is in flight the button is busy (the kit's Button): it keeps focus and a press does nothing.
      await expect(stayButton(page)).toHaveAttribute('aria-busy', 'true');
      await jumpPastTimers(page, 130_000);
      await expect(page.getByRole('dialog')).toHaveCount(0, SHORT); // the schedule closes it at the deadline
      await expect.poll(() => held !== undefined, SHORT).toBe(true);
      await held!.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"x"}' });

      // A failure that arrives after the deadline is not "try again": the session is over, so the page
      // says so in the non-modal notice and does not open the dialog or show the failed-read line.
      await expect(page.getByRole('alert').filter({ hasText: ENDED })).toBeVisible(SHORT);
      await page.waitForTimeout(500);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByText(FAILED)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('UX-43: a read the server answers with a session after the local deadline still extends the session', async ({ browser }) => {
    // The server accepts the token up to exp + 15 s and has just re-signed it, so its answer decides, not the local clock.
    const { slug, context, page } = await ownerPage(browser);
    try {
      await page.clock.install();
      await open(page, `/orgs/${slug}/dashboard`);
      const before = await reachWarning(page, context);
      await page.waitForTimeout(1500);
      let held: Route | undefined;
      await page.route('**/api/auth/session', (route) => {
        held = route;
      });
      await stayButton(page).click();
      await jumpPastTimers(page, 130_000);
      await expect(page.getByRole('dialog')).toHaveCount(0, SHORT);
      await expect.poll(() => held !== undefined, SHORT).toBe(true);
      await held!.continue(); // the real server answers with the session

      await expect.poll(async () => expiry(context), SHORT).toBeGreaterThan(before);
      await page.waitForTimeout(500);
      await expect(page.getByText(ENDED)).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      // The deadline is counted from the extension again.
      await page.clock.fastForward(43_000_000);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.clock.fastForward(85_000);
      await expect(page.getByRole('dialog')).toContainText(WARNING, SHORT);
    } finally {
      await context.close();
    }
  });

  test('UX-43: a second tab adopts the extension and ignores a malformed message', async ({ browser }) => {
    const { slug, context, page } = await ownerPage(browser);
    try {
      const second = await context.newPage();
      await page.clock.install(); // the clock belongs to the context, so both tabs share it
      await open(page, `/orgs/${slug}/dashboard`);
      await open(second, `/orgs/${slug}/dashboard`);
      await reachWarning(page, context);
      await expect(second.getByRole('dialog')).toContainText(WARNING, SHORT);

      const secondReads = countSessionReads(second);
      await page.evaluate(() => {
        const channel = new BroadcastChannel('makrai-idle');
        channel.postMessage({ secondsLeft: NaN, absoluteSecondsLeft: 1 });
        channel.close();
      });
      await second.waitForTimeout(1000);
      await expect(second.getByRole('dialog')).toBeVisible(); // the malformed message was ignored

      await page.waitForTimeout(1500);
      await stayButton(page).click();
      await expect(page.getByRole('dialog')).toHaveCount(0, SHORT);
      await expect(second.getByRole('dialog')).toHaveCount(0, SHORT);
      expect(secondReads).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("UX-43: a failed read that settles after another tab's extension is dropped and opens nothing", async ({ browser }) => {
    // Tab A presses Stay on a bad link and the read hangs; tab B stays signed in and tells tab A, whose countdown restarts and whose
    // dialog closes. The answer that finally arrives belongs to a deadline that has since moved: it must not open a modal that says
    // two minutes are left when twelve hours are.
    const { slug, context, page } = await ownerPage(browser);
    try {
      const second = await context.newPage();
      await page.clock.install(); // the clock belongs to the context, so both tabs share it
      await open(page, `/orgs/${slug}/dashboard`);
      await open(second, `/orgs/${slug}/dashboard`);
      await reachWarning(page, context);
      await expect(second.getByRole('dialog')).toContainText(WARNING, SHORT);

      let held: Route | undefined;
      await page.route('**/api/auth/session', (route) => {
        held = route;
      });
      await stayButton(page).click();
      // While the read is in flight the button is busy (the kit's Button): it keeps focus and a press does nothing.
      await expect(stayButton(page)).toHaveAttribute('aria-busy', 'true');
      await expect.poll(() => held !== undefined, SHORT).toBe(true);

      await page.waitForTimeout(1500); // so the new expiry differs from the old
      await stayButton(second).click();
      await expect(second.getByRole('dialog')).toHaveCount(0, SHORT);
      await expect(page.getByRole('dialog')).toHaveCount(0, SHORT); // tab A adopted the extension

      await held!.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"x"}' });
      await page.waitForTimeout(1000);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByText(FAILED)).toHaveCount(0);
      await expect(page.getByText(ENDED)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("UX-43: an extension from another tab clears the signed-out notice and the warning works again", async ({ browser }) => {
    // Tab A learned the session had ended (B35). The person signs in again and stays signed in in tab B, which tells tab A: the
    // notice is stale, and tab A must warn again at the new deadline instead of staying silent with the notice still on top.
    const { slug, context, page } = await ownerPage(browser);
    try {
      const second = await context.newPage();
      await page.clock.install();
      await open(page, `/orgs/${slug}/dashboard`);
      await open(second, `/orgs/${slug}/dashboard`);
      await reachWarning(page, context);

      await context.clearCookies();
      await stayButton(page).click(); // the endpoint answers a JSON null
      const notice = page.getByRole('alert').filter({ hasText: ENDED });
      await expect(notice).toBeVisible(SHORT);

      await second.evaluate(() => {
        const channel = new BroadcastChannel('makrai-idle');
        channel.postMessage({ secondsLeft: 43200, absoluteSecondsLeft: 600000 });
        channel.close();
      });
      await expect(notice).toHaveCount(0, SHORT);

      // Counted from the message: no dialog before the warning window, the dialog inside it.
      await page.clock.fastForward(43_000_000);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.clock.fastForward(85_000);
      await expect(page.getByRole('dialog')).toContainText(WARNING, SHORT);
    } finally {
      await context.close();
    }
  });

  test("UX-43: every signed-in page carries the idle dialog with the cookie's remaining seconds, and a signed-out page carries none", async ({
    browser,
    request,
  }) => {
    // R11-5: UX-43 says every signed-in page, S-31 and the second organisation's 404 included.
    const { slug, context } = await ownerPage(browser);
    try {
      for (const [url, status] of [
        [`/orgs/${slug}/dashboard`, 200],
        ['/explore/framework', 200],
        ['/no-such-page', 404],
      ] as const) {
        const response = await context.request.get(url);
        expect(response.status(), url).toBe(status);
        const html = await response.text();
        // One wrapper carrying the seconds, holding the one warning dialog (the kit's).
        const wrappers = [...html.matchAll(/<div class="shell-idle" data-seconds-left="(\d+)">/g)];
        expect(wrappers, url).toHaveLength(1);
        expect([...html.matchAll(/<dialog\b[^>]*\bclass="ui-dialog"[^>]*>/g)], url).toHaveLength(1);
        const seconds = Number(wrappers[0][1]);
        expect(Number.isInteger(seconds) && seconds >= 1 && seconds <= 43200, `${url} ${seconds}`).toBe(true);
      }
    } finally {
      await context.close();
    }

    // A request with no cookie: S-31 and the sign-in page carry no dialog.
    const signedOutNotFound = await request.get('/no-such-page');
    expect(signedOutNotFound.status()).toBe(404);
    const signedOutHtml = await signedOutNotFound.text();
    // Not vacuous: the page is the one the signed-in visit above read the wrapper from.
    expect(signedOutHtml).toContain(NOT_FOUND_COPY.body);
    expect(signedOutHtml).not.toContain('shell-idle');
    expect(signedOutHtml).not.toContain('data-seconds-left');
    const login = await request.get('/login');
    expect(login.status()).toBe(200);
    const loginHtml = await login.text();
    expect(loginHtml).toContain('shell-public-header');
    expect(loginHtml).not.toContain('shell-idle');
    expect(loginHtml).not.toContain('data-seconds-left');
  });

  test('UX-43 (S-31): a signed-in visit to an unknown address shows the warning on schedule', async ({ browser }) => {
    const { context, page } = await ownerPage(browser);
    try {
      await page.clock.install();
      const response = await open(page, '/no-such-page');
      expect(response!.status()).toBe(404);
      const before = await expiry(context);
      await page.clock.fastForward(await toBefore(page, before, 135));
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.clock.fastForward(20_000);
      await expect(page.getByRole('dialog')).toContainText(WARNING, SHORT);
    } finally {
      await context.close();
    }
  });

  test("UX-43 (S-31): another organisation's address, refused inside the signed-in layout, carries exactly one idle dialog and one main", async ({ browser }) => {
    // notFound() thrown by app/(authenticated)/orgs/[slug]/layout.tsx is caught below app/(authenticated)/layout.tsx,
    // so S-31 renders inside that layout and not in place of it. Without app/(authenticated)/not-found.tsx the root page
    // rendered there too (measured on Next 16.4.2 in dev: two dialogs, two main landmarks and the sidebar, now the rail). The browser
    // must end up with the layout's one warning and the layout's one main, not two of each.
    const { otherSlug, context, page } = await ownerPage(browser);
    try {
      const response = await open(page, `/orgs/${otherSlug}/dashboard`);
      expect(response!.status()).toBe(404);
      await expect(page.locator('.shell-idle dialog.ui-dialog')).toHaveCount(1);
      await expect(page.locator('dialog')).toHaveCount(1);
      await expect(page.locator('main')).toHaveCount(1);
      await expect(page.locator('main')).toContainText(NOT_FOUND_COPY.body);
      await expect(page.locator('.shell-rail')).toHaveCount(1);
    } finally {
      await context.close();
    }
  });
});

test.describe('idle-sign-out warning on the seam server (MAKRAI_TEST_IDLE_SECONDS=180)', () => {
  test.skip(!SEAM_RUN, 'run with MAKRAI_TEST_SEAMS=1 MAKRAI_TEST_IDLE_SECONDS=180 so the server uses the 3-minute limit');

  /** Signs the owner seat in on the /login form, from its own address so the sign-in rate limit is not shared. */
  async function signedInOwner(browser: Browser, lastOctet: number) {
    const { slug, seat } = ownerSeat();
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': `10.42.9.${lastOctet}` } });
    const page = await context.newPage();
    await page.goto('/login');
    await page.fill('#email', seat.email);
    await page.fill('#password', seat.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/');
    return { slug, context, page };
  }

  test("UX-43: a page opened late warns by the session's deadline", async ({ browser }) => {
    test.setTimeout(120_000);
    const { slug, context, page } = await signedInOwner(browser, 11);
    try {
      await page.waitForTimeout(70_000); // no request: the cookie keeps counting down
      await open(page, `/orgs/${slug}/dashboard`);
      // A timer that starts at mount would open the dialog 55 s after this load and fail here.
      await expect(page.getByRole('dialog')).toContainText(WARNING, SHORT);
    } finally {
      await context.close();
    }
  });

  test("UX-43: ignoring the warning signs the person out at the cookie's expiry", async ({ browser }) => {
    test.setTimeout(240_000);
    const { slug, context, page } = await signedInOwner(browser, 12);
    try {
      await open(page, `/orgs/${slug}/dashboard`);
      await expect(page.getByRole('dialog')).toContainText(WARNING, { timeout: 90_000 });
      const expires = await expiry(context);
      await page.waitForTimeout(Math.max(0, expires * 1000 + 5_000 - Date.now())); // real time, no request
      await expect(page.getByRole('dialog')).toHaveCount(0, SHORT);
      await page.reload();
      await expect(page).toHaveURL(/\/login/);
    } finally {
      await context.close();
    }
  });
  test('C12: when the deadline passes with no click, the signed-out notice appears with the 12-hour reason and its link returns to this page', async ({ browser }) => {
    test.setTimeout(300_000);
    const { slug, context, page } = await signedInOwner(browser, 13);
    try {
      const path = `/orgs/${slug}/dashboard`;
      await open(page, path);
      await expect(page.getByRole('dialog')).toContainText(WARNING, { timeout: 90_000 });
      await expect(page.getByRole('dialog')).toContainText(IDLE_TEXTS.warningBody);
      const expires = await expiry(context);
      await page.waitForTimeout(Math.max(0, expires * 1000 + 5_000 - Date.now())); // real time, no request
      await expect(page.getByRole('dialog')).toHaveCount(0, SHORT);
      const notice = page.getByRole('alert').filter({ hasText: IDLE_TEXTS.endedIdle });
      await expect(notice).toHaveText(`${IDLE_TEXTS.endedIdle} ${ENDED}${IDLE_TEXTS.signInAgain}`, SHORT);
      await expect(page.locator('main')).toBeVisible(); // the page stays as it was, behind no modal
      expect(await page.evaluate(() => document.querySelector('main')?.closest('[inert]') !== null)).toBe(false);

      // In a new tab nothing is said: the hint is this tab's.
      const other = await context.newPage();
      await other.goto('/login');
      await expect(other.getByRole('heading', { level: 1 })).toBeVisible();
      await other.waitForTimeout(500);
      await expect(other.getByText(AUTH_COPY.signedOutIdle)).toHaveCount(0);
      await other.close();

      await notice.getByRole('link', { name: IDLE_TEXTS.signInAgain }).click();
      await page.waitForURL(/\/login\?callbackUrl=/);
      await expect(page.getByText(AUTH_COPY.signedOutIdle)).toBeVisible(SHORT);
      await expect(page.getByText(AUTH_COPY.signedOutKept)).toBeVisible();
      const { seat } = ownerSeat();
      await page.fill('#email', seat.email);
      await page.fill('#password', seat.password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL((url) => url.pathname === path, { timeout: 30_000 });
      // Read once: S-01 says nothing the next time.
      await page.goto('/login');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForTimeout(500);
      await expect(page.getByText(AUTH_COPY.signedOutIdle)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
