import 'dotenv/config';
import { MY_ACCEPTANCES_COPY } from '../lib/legal/copy';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { testDb } from '../__tests__/helpers/db';
import { buildOrg, type FixtureAccount, type FixtureMember } from '../__tests__/helpers/recordFixture';
import { e2eBaseURL } from './helpers/port';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { AUTH_COPY, AUTH_MESSAGE_COPY, CHANGE_PASSWORD_COPY, FORGOT_COPY, RESET_COPY, SIGN_IN_COPY } from '../lib/auth/copy';
import { expectTargetsAtLeast24px } from './helpers/targetSize';
import { ACCOUNT_COPY, PERSONAL_DATA_COPY, SIGN_OUT_EVERYWHERE_COPY, phraseLabel } from '../lib/account/copy';
import { DELETE_PHRASE, DELETION_UNCONFIRMED } from '../lib/export/messages';
import { EMAIL_COPY } from '../lib/email/copy';

/**
 * S-21, S-29 and the session endpoint on a running server (FR-ACC-06 to FR-ACC-09, NFR-SEC-07, UX-01, NFR-A11Y-02,
 * NFR-A11Y-04, NFR-A11Y-05; obligations B12 and B21). What the vitest cases cannot do (a real cookie, Next's request
 * scope, a click) is driven here. Accounts are made per test with K0a's buildOrg, and the database is read back with the
 * owner role (counts and flags only).
 *
 * The session-endpoint cases speak HTTP with Node's own fetch, so every cookie sent is the one the test chose: sign in
 * with the CSRF token and the credentials POST, keep the session cookie, end the session, then read
 * `/api/auth/session` with the old cookie. The two J-15 cases need a reset email to follow, so they run under
 * playwright.nginx.config.ts (its mail catcher), tagged @nginx; the default config lists them as skipped.
 */
const BASE = e2eBaseURL(process.env);
const SESSION_COOKIE = /^(__Secure-)?authjs\.session-token(\.\d+)?$/;
const M22 = 'This link has expired or has already been used. Ask for a new one.';

type Jar = Map<string, string>;

/** Takes a response's Set-Cookie lines into `jar`: an empty value or Max-Age=0 removes the cookie. */
function absorb(jar: Jar, res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(';')[0];
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    if (value === '' || /;\s*max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
}
const cookieHeader = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const sessionOnly = (jar: Jar) => new Map([...jar].filter(([k]) => SESSION_COOKIE.test(k)));

async function csrf(jar: Jar): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/csrf`, { headers: { cookie: cookieHeader(jar) } });
  absorb(jar, res);
  return ((await res.json()) as { csrfToken: string }).csrfToken;
}

/** Signs in through the API as a browser does, and returns the session cookie only. */
async function apiSignIn(a: Pick<FixtureAccount, 'email' | 'password'>): Promise<Jar> {
  const jar: Jar = new Map();
  const csrfToken = await csrf(jar);
  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-auth-return-redirect': '1', cookie: cookieHeader(jar) },
    body: new URLSearchParams({ csrfToken, email: a.email, password: a.password, callbackUrl: `${BASE}/` }),
  });
  absorb(jar, res);
  const session = sessionOnly(jar);
  if (session.size === 0) throw new Error(`apiSignIn: no session cookie after sign-in (status ${res.status})`);
  return session;
}

async function readSession(cookie: string): Promise<{ status: number; body: unknown; res: Response }> {
  const res = await fetch(`${BASE}/api/auth/session`, { headers: { cookie } });
  return { status: res.status, body: await res.json(), res };
}

/** The `POST /api/auth/session` the session update sends: the old cookie, a CSRF token got with it, and `data={}`. */
async function updateSession(session: Jar): Promise<{ status: number; body: unknown; res: Response }> {
  const jar: Jar = new Map(session);
  const csrfToken = await csrf(jar);
  const res = await fetch(`${BASE}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
    body: new URLSearchParams({ csrfToken, data: '{}' }),
  });
  return { status: res.status, body: await res.json(), res };
}

/** Every Set-Cookie of `res` is empty with Max-Age=0, and none sets a session token. */
function expectNoFreshToken(res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    expect(line, 'a cleared cookie').toMatch(/^[^=]+=;/);
    expect(line).toMatch(/Max-Age=0/i);
  }
  expect(res.headers.getSetCookie().some((l) => /session-token(\.\d+)?=[^;]/.test(l))).toBe(false);
}

const attrs = (line: string) => new Set(line.split(';').slice(1).map((s) => s.trim().toLowerCase()));

let ipSeq = 0;
async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': `10.61.0.${++ipSeq}` } });
  return context.newPage();
}

/**
 * Opens `url` as a new document, so every check sees the page as it renders in the current theme and size. A plain goto
 * to an address that differs from the current one only in the fragment stays in the same document: S-03 strips its token
 * from the address, so its next visit was such a navigation, the theme change ran the page's colour transitions on the
 * live page (`a { transition: color }` and others), and axe could read their first frames, light-theme link colours on the
 * dark background (CI run 41907649999: S-03 dark 1280, color-contrast on every header and footer link).
 */
async function loadAfresh(page: Page, url: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(url);
}

async function signInPage(page: Page, account: Pick<FixtureAccount, 'email' | 'password'>): Promise<void> {
  await page.goto('/login');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
}

/**
 * Waits for the scroll to stop: `html { scroll-behavior: smooth }` means a box measured right after a focus or a key press is
 * read on a page in motion (ruling T16-22). From 1024 px the scroller is `main.shell__main`, below it the window. Settled is
 * the same position on two polls 100 ms apart; the predicate is synchronous because waitForFunction takes a returned Promise
 * as a truthy answer at once.
 */
async function scrollSettled(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { lastScrollAt?: number }).lastScrollAt = Number.NaN; });
  await page.waitForFunction(() => {
    const w = window as unknown as { lastScrollAt?: number };
    const main = document.querySelector('.shell__main');
    const at = window.scrollY + (main ? main.scrollTop : 0);
    const settled = w.lastScrollAt === at;
    w.lastScrollAt = at;
    return settled;
  }, undefined, { polling: 100 });
}

/** A live reset token for `m`, written as route 33 would write it (the hash only). */
async function resetTokenFor(m: FixtureMember): Promise<string> {
  const raw = randomBytes(32).toString('hex');
  await testDb.passwordResetToken.create({ data: { userId: m.userId, tokenHash: createHash('sha256').update(raw).digest('hex'), expiresAt: new Date(Date.now() + 30 * 60_000) } });
  return raw;
}

test.afterAll(async () => {
  await testDb.$disconnect();
});

test.describe('My account and sessions', () => {
  test('FR-ACC-07: sign out everywhere in one browser signs the other out on its next request', async ({ browser }) => {
    const a = (await buildOrg({ label: 'soe' })).members.assessor;
    const one = await newPage(browser);
    const two = await newPage(browser);
    await signInPage(one, a);
    await signInPage(two, a);
    await one.goto('/account');
    await expect(one.getByRole('heading', { level: 1, name: ACCOUNT_COPY.page.heading })).toBeVisible();
    await expect(one.getByText(SIGN_OUT_EVERYWHERE_COPY.explains)).toBeVisible();
    await one.getByRole('button', { name: SIGN_OUT_EVERYWHERE_COPY.button }).click();
    await one.waitForURL((url) => url.pathname === '/login');
    await two.goto('/account');
    await expect(two).toHaveURL(/\/login/);
    expect((await testDb.user.findUniqueOrThrow({ where: { id: a.userId } })).sessionEpoch).toBe(1);
  });

  test('FR-ACC-04 UX-01: a pre-v1 account loads /account, and its pre-v1 row says it was an older version, with Read and accept to /acceptances', async ({ browser }) => {
    const a = (await buildOrg({ label: 'prev1', acceptances: 'pre-v1' })).members.viewer;
    const page = await newPage(browser);
    await page.goto('/login');
    await page.fill('#email', a.email);
    await page.fill('#password', a.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname !== '/login');
    const res = await page.goto('/account');
    expect(res?.status()).toBe(200);
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole('heading', { name: MY_ACCEPTANCES_COPY.heading })).toBeVisible();
    await expect(page.getByText(MY_ACCEPTANCES_COPY.olderVersion).first()).toBeVisible();
    await expect(page.getByRole('link', { name: MY_ACCEPTANCES_COPY.readAndAccept }).first()).toHaveAttribute('href', '/acceptances');
    await expect(page.getByRole('button', { name: SIGN_OUT_EVERYWHERE_COPY.button })).toBeVisible();
  });

  test('UX-29 UX-42 FR-EXP-03: Delete my account, opened with the keyboard at 1280 by 720, leaves the password field and both buttons inside the viewport', async ({ browser }) => {
    // components/ui/InlineConfirm.tsx brings a confirmation that opens wholly into view; the boxes are printed below.
    // This case measures against the window only. The full check (every clipping ancestor and the scroller's visible
    // box) is in e2e/inline-confirm-reveal.spec.ts.
    const a = (await buildOrg({ label: 'delconf' })).members.assessor;
    const page = await newPage(browser);
    await page.setViewportSize({ width: 1280, height: 720 });
    await signInPage(page, a);
    await page.goto('/account');
    await expect(page.getByRole('heading', { level: 1, name: ACCOUNT_COPY.page.heading })).toBeVisible();
    await tabTo(page, page.getByRole('button', { name: PERSONAL_DATA_COPY.deleteTrigger }));
    await page.keyboard.press('Enter');
    const password = page.getByLabel(PERSONAL_DATA_COPY.passwordLabel);
    await expect(password).toBeFocused();
    await scrollSettled(page);
    // At 1280 px the scroller is main.shell__main, so a box is placed against the window's viewport, never against the scroller.
    const view = page.viewportSize()!;
    const confirm = page.locator('.ui-confirm');
    const boxes: Array<[string, { x: number; y: number; width: number; height: number }]> = [
      ['the password field', (await password.boundingBox())!],
      ['the Cancel button', (await confirm.getByRole('button', { name: 'Cancel', exact: true }).boundingBox())!],
      ['the Delete my account button', (await confirm.getByRole('button', { name: PERSONAL_DATA_COPY.deleteAction, exact: true }).boundingBox())!],
    ];
    const printed = boxes.map(([what, b]) => `${what} ${Math.round(b.x)},${Math.round(b.y)} to ${Math.round(b.x + b.width)},${Math.round(b.y + b.height)}`).join('; ');
    console.log(`Confirmation boxes in ${view.width}x${view.height}: ${printed}`);
    for (const [what, b] of boxes) {
      expect(b.x >= 0 && b.y >= 0 && b.x + b.width <= view.width && b.y + b.height <= view.height, `${what} is wholly inside the viewport (${printed})`).toBe(true);
    }
  });

  test('UX-29 FR-EXP-03: a second deletion answer with the same words empties the alert first, so it is said again', async ({ browser }) => {
    const a = (await buildOrg({ label: 'delagain' })).members.assessor;
    const page = await newPage(browser);
    await signInPage(page, a);
    // Route 39 answers a 500 with an empty JSON body twice: the screen says the outcome is not known, both times.
    let deletes = 0;
    await page.route('**/api/users/me', async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      deletes += 1;
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/account');
    await page.getByRole('button', { name: PERSONAL_DATA_COPY.deleteTrigger }).click();
    // A wrong password, as e2e/inline-confirm-reveal.spec.ts does: the route above answers before any server reads it,
    // and if it ever stopped matching, no real deletion would run.
    await page.getByLabel(PERSONAL_DATA_COPY.passwordLabel).fill('not-the-password');
    await page.getByLabel(phraseLabel(DELETE_PHRASE)).fill(DELETE_PHRASE);
    const region = page.locator('.ui-confirm [role="alert"]');
    await expect(region).toHaveText('');
    // Every text the region holds, in order, recorded from before the first press.
    await region.evaluate((el) => {
      const seen: string[] = [];
      (window as unknown as { alertTexts: string[] }).alertTexts = seen;
      new MutationObserver(() => {
        const text = el.textContent ?? '';
        if (seen[seen.length - 1] !== text) seen.push(text);
      }).observe(el, { childList: true, characterData: true, subtree: true });
    });
    const confirm = page.locator('.ui-confirm').getByRole('button', { name: PERSONAL_DATA_COPY.deleteAction, exact: true });
    await confirm.click();
    await expect(region).toHaveText(DELETION_UNCONFIRMED);
    await confirm.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { alertTexts: string[] }).alertTexts)).toEqual([DELETION_UNCONFIRMED, '', DELETION_UNCONFIRMED]);
    await expect(region).toHaveText(DELETION_UNCONFIRMED);
    expect(deletes).toBe(2);
  });

  test('UX-26 FR-ACC-05 B17: signing in on S-01 removes another account\'s drafts from this browser and keeps one\'s own', async ({ browser }) => {
    const fx = await buildOrg({ label: 'purge' });
    const a = fx.members.assessor;
    const b = fx.members.reviewer;
    const page = await newPage(browser);
    await page.goto('/login');
    const draft = JSON.stringify({ baseVersionNumber: null, value: { reason: 'x' }, savedAt: new Date().toISOString(), savePressedAt: null, retry: { requestId: null, sentBody: null } });
    const keyOf = (userId: string) => `makrai.draft.v1:${userId}:${fx.org.id}:p1:q:Q-PP-01`;
    await page.evaluate(([ka, kb, v]) => { localStorage.setItem(ka, v); localStorage.setItem(kb, v); }, [keyOf(a.userId), keyOf(b.userId), draft]);
    await page.fill('#email', b.email);
    await page.fill('#password', b.password);
    await page.locator('button[type="submit"]').click();
    await page.getByRole('button', { name: AUTH_COPY.removeAndContinue }).click(); // D16 asks first (plan 1B Task 5)
    await page.waitForURL((url) => url.pathname !== '/login');
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('makrai.draft.v1:')));
    expect(keys).toEqual([keyOf(b.userId)]);
  });

  test('FR-ACC-05 (C4 ruling F2): a 502 page instead of an answer gives the form back with the connection-lost text', async ({ browser }) => {
    const a = (await buildOrg({ label: 'lost' })).members.assessor;
    const page = await newPage(browser);
    // A regex, not a glob: next-auth/react posts to the path with a query string ('...credentials?').
    await page.route(/\/api\/auth\/callback\/credentials(\?|$)/, (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>' }));
    await page.goto('/login');
    await page.fill('#email', a.email);
    await page.fill('#password', a.password);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByText(SIGN_IN_COPY.connectionLost)).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeEnabled();
    await expect(page.locator('button[type="submit"]')).toHaveText(SIGN_IN_COPY.submit);
  });

  test('FR-ACC-04 FR-ACC-08 (C4 ruling RE-5): a pre-v1 account opens S-29 from S-21', async ({ browser }) => {
    const a = (await buildOrg({ label: 'prev1cp', acceptances: 'pre-v1' })).members.viewer;
    const page = await newPage(browser);
    await signInPage(page, a);
    await page.goto('/account');
    await page.getByRole('link', { name: 'Change password' }).click();
    await page.waitForURL(/\/change-password$/);
    await expect(page.getByRole('heading', { level: 1, name: AUTH_COPY.titles.changePassword })).toBeVisible();
    // Plan 1B Task 3 (T3.2): the voluntary view leads back to My account, and does not say the change is forced.
    await expect(page.getByRole('link', { name: CHANGE_PASSWORD_COPY.backToAccount })).toHaveAttribute('href', '/account');
    await expect(page.getByText(AUTH_COPY.forcedLead)).toHaveCount(0);
    // A hard load of the page gets the same.
    await page.goto('/change-password');
    await expect(page).toHaveURL(/\/change-password$/);
  });

  test('UX-01 FR-ACC-08: a flagged account reaches only S-29', async ({ browser }) => {
    const fx = await buildOrg({ label: 'flag' });
    const a = fx.members.assessor;
    await testDb.user.update({ where: { id: a.userId }, data: { mustChangePassword: true } });
    const page = await newPage(browser);
    await signInPage(page, a);
    for (const path of ['/account', `/orgs/${fx.org.slug}/dashboard`, '/acceptances']) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/change-password$/);
    }
    await expect(page.getByRole('heading', { level: 1, name: AUTH_COPY.titles.changePassword })).toBeVisible();
    await expect(page.getByLabel(CHANGE_PASSWORD_COPY.currentPassword)).toHaveAttribute('autocomplete', 'current-password');
    await expect(page.getByLabel(CHANGE_PASSWORD_COPY.newPassword)).toHaveAttribute('autocomplete', 'new-password');
    // Plan 1B Task 3 (T3.2): the forced view says why and links nowhere.
    await expect(page.getByText(AUTH_COPY.forcedLead)).toBeVisible();
    await expect(page.getByRole('main').getByRole('link')).toHaveCount(0);
  });

  test('NFR-SEC-07 FR-ACC-07 FR-ACC-08 B21: after sign out everywhere, a password change, deactivation and 7 days, GET /api/auth/session answers null and sets no fresh session cookie', async () => {
    const fx = await buildOrg({ label: 'b21' });
    // The run's one platform administrator (the setup's seat): the database refuses a second (NFR-SEC-19, migration
    // *_v060_identity_revoke), so this case acts as the existing one.
    const admin = { userId: (await testDb.user.findFirstOrThrow({ where: { role: 'admin' }, select: { id: true } })).id };
    const cases: Array<[string, FixtureMember, (a: FixtureMember, cookie: string) => Promise<string>]> = [
      ['sign out everywhere', fx.members.assessor, async (_a, cookie) => {
        const r = await fetch(`${BASE}/api/users/me/sessions`, { method: 'DELETE', headers: { cookie, origin: BASE } });
        expect(r.status).toBe(200);
        return cookie;
      }],
      ['password change', fx.members.reviewer, async (a, cookie) => {
        const r = await fetch(`${BASE}/api/users/me/password`, {
          method: 'POST', headers: { cookie, origin: BASE, 'content-type': 'application/json' },
          body: JSON.stringify({ currentPassword: a.password, newPassword: 'c'.repeat(12) }),
        });
        expect(r.status).toBe(200);
        return cookie;
      }],
      ['deactivation', fx.members.viewer, async (a, cookie) => {
        await testDb.$queryRaw`SELECT admin_set_account_active(${admin.userId}::text, ${a.userId}::text, false, NULL::text, ${[fx.org.id]}::text[])`;
        return cookie;
      }],
      ['7 days', fx.members.admin, async (a) => {
        const name = 'authjs.session-token';
        const { sessionEpoch } = await testDb.user.findUniqueOrThrow({ where: { id: a.userId } });
        const token = await encode({
          salt: name, secret: process.env.NEXTAUTH_SECRET!,
          token: { id: a.userId, sessionEpoch, sessionIssuedAt: Math.floor(Date.now() / 1000) - 7 * 24 * 3600 - 60 },
        });
        return `${name}=${token}`;
      }],
    ];
    for (const [kind, a, end] of cases) {
      const session = await apiSignIn(a);
      const live = await readSession(cookieHeader(session));
      expect([kind, live.status, (live.body as { user?: { id?: string } } | null)?.user?.id]).toEqual([kind, 200, a.userId]);
      const old = await end(a, cookieHeader(session));

      const read = await readSession(old);
      expect([kind, read.status, read.body]).toEqual([kind, 200, null]);
      expectNoFreshToken(read.res);

      const oldJar: Jar = new Map(old.split('; ').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
      const update = await updateSession(oldJar);
      expect([kind, update.status, update.body]).toEqual([kind, 200, null]);
      expect(update.res.headers.get('cache-control'), kind).toBeNull();
      expect(update.res.headers.get('content-type'), kind).toBe('application/json');
      expectNoFreshToken(update.res);

      const page = await fetch(`${BASE}/account`, { headers: { cookie: old }, redirect: 'manual' });
      expect([kind, page.status]).toEqual([kind, 307]);
      expect(new URL(page.headers.get('location') ?? '', BASE).pathname, kind).toBe('/login');
    }
  });

  test('NFR-SEC-07 B21: the refused answer is next-auth\'s own answer for an unreadable cookie', async () => {
    const a = (await buildOrg({ label: 'unread' })).members.assessor;
    const unreadable = await readSession('authjs.session-token=not-a-token');
    const session = await apiSignIn(a);
    await fetch(`${BASE}/api/users/me/sessions`, { method: 'DELETE', headers: { cookie: cookieHeader(session), origin: BASE } });
    const revoked = await readSession(cookieHeader(session));
    for (const r of [unreadable, revoked]) {
      expect([r.status, r.body]).toEqual([200, null]);
      expect(r.res.headers.get('content-type')).toBe('application/json');
      expect([r.res.headers.get('cache-control'), r.res.headers.get('expires'), r.res.headers.get('pragma')]).toEqual(['private, no-cache, no-store', '0', 'no-cache']);
      const [line] = r.res.headers.getSetCookie();
      expect(line.split('=')[0]).toBe('authjs.session-token');
      expect(attrs(line)).toEqual(new Set(['path=/', 'max-age=0', 'httponly', 'samesite=lax']));
    }
    // next-auth's own clearing of the same cookie (its sign-out) carries the same attributes.
    const fresh = await apiSignIn(a);
    const jar: Jar = new Map(fresh);
    const csrfToken = await csrf(jar);
    const out = await fetch(`${BASE}/api/auth/signout`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-auth-return-redirect': '1', cookie: cookieHeader(jar) },
      body: new URLSearchParams({ csrfToken, callbackUrl: `${BASE}/login` }),
    });
    const theirs = out.headers.getSetCookie().find((l) => l.startsWith('authjs.session-token='));
    expect(theirs, 'next-auth clears the session cookie on sign-out').toBeTruthy();
    const ours = [...attrs(revoked.res.headers.getSetCookie()[0])].filter((x) => !x.startsWith('expires='));
    expect([...attrs(theirs!)].filter((x) => !x.startsWith('expires=')).sort()).toEqual(ours.sort());
  });

  test('NFR-SEC-07 UX-43 B21: a live session still answers 200 with user, id and sessionEpoch and moves the cookie\'s expiry', async () => {
    const a = (await buildOrg({ label: 'live' })).members.assessor;
    const session = await apiSignIn(a);
    const expiry = (r: Response) => {
      const line = r.headers.getSetCookie().find((l) => /^authjs\.session-token=[^;]/.test(l));
      expect(line, 'a re-signed session cookie').toBeTruthy();
      return Date.parse(/expires=([^;]+)/i.exec(line!)![1]);
    };
    const first = await readSession(cookieHeader(session));
    await new Promise((r) => setTimeout(r, 2_000));
    const second = await readSession(cookieHeader(session));
    for (const r of [first, second]) {
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ user: { id: a.userId }, sessionEpoch: 0 });
    }
    expect(expiry(second.res)).toBeGreaterThan(expiry(first.res));
  });

  test('NFR-SEC-07 B21: a live session\'s POST /api/auth/session still answers 200 with the user and moves the cookie\'s expiry', async () => {
    const a = (await buildOrg({ label: 'livepost' })).members.assessor;
    const update = await updateSession(await apiSignIn(a));
    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({ user: { id: a.userId } });
    expect(update.res.headers.getSetCookie().some((l) => /^authjs\.session-token=[^;]/.test(l))).toBe(true);
  });

  test('NFR-A11Y-04 NFR-A11Y-05: S-01, S-02, S-03, S-21 and S-29 have no serious axe violation in both themes at 1280 and 360 pixels, 24-pixel targets, no loss at 320 pixels', async ({ browser }) => {
    test.setTimeout(180_000);
    const fx = await buildOrg({ label: 'a11y' });
    const flagged = fx.members.viewer;
    await testDb.user.update({ where: { id: flagged.userId }, data: { mustChangePassword: true } });
    const anon = await newPage(browser);
    const member = await newPage(browser);
    await signInPage(member, fx.members.assessor);
    const forced = await newPage(browser);
    await signInPage(forced, flagged);
    const screens: Array<[string, Page, () => Promise<string>]> = [
      ['S-01', anon, async () => '/login'],
      ['S-02', anon, async () => '/forgot-password'],
      ['S-03', anon, async () => `/reset-password#token=${await resetTokenFor(fx.members.reviewer)}`],
      ['S-21', member, async () => '/account'],
      ['S-29', forced, async () => '/change-password'],
    ];
    for (const [screen, page, path] of screens) {
      for (const colorScheme of ['light', 'dark'] as const) for (const width of [1280, 360]) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        await loadAfresh(page, await path());
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        // The submit button is disabled until hydration and the kit's button changes colour over 150 ms when it is
        // enabled: wait for the enabled button; the accessibility check itself waits for running transitions to end.
        const submit = page.locator('form button[type="submit"]');
        if (await submit.count()) await expect(submit.first()).toBeEnabled();
        await expectNoSeriousA11yViolations(page, `${screen} ${colorScheme} ${width}`);
        await expectTargetsAtLeast24px(page);
      }
      await page.setViewportSize({ width: 320, height: 900 });
      await loadAfresh(page, await path());
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
    // S-03's token is out of the address before any request, and a link with no token says M-22.
    await anon.goto(`/reset-password#token=${await resetTokenFor(fx.members.reviewer)}`);
    await expect(anon.getByLabel(RESET_COPY.newPassword)).toBeVisible();
    expect(new URL(anon.url()).hash).toBe('');
    await anon.goto('/reset-password');
    await expect(anon.locator('.ui-status--error')).toHaveText(M22);
  });
});

/** The last E-03 for `email` in the mail catcher's out file, and its token. */
function mailedResetToken(email: string): string | null {
  const lines = readFileSync(process.env.E2E_MAIL_OUT!, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; to: unknown; text?: string });
  const mail = lines.filter((l) => l.kind === 'email' && JSON.stringify(l.to).includes(email)).at(-1);
  return mail?.text ? (/#token=([0-9a-f]{64})/.exec(mail.text)?.[1] ?? null) : null;
}

/** Tab until `target` has focus, checking at each press that the focused element is visible and not covered. */
async function tabTo(page: Page, target: ReturnType<Page['locator']>, max = 40): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    await expectFocusVisibleAndUncovered(page);
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`tabTo: ${max} presses of Tab did not reach the target`);
}

test.describe('J-15 with a mail catcher', { tag: '@nginx' }, () => {
  test.skip(!process.env.E2E_MAIL_OUT, 'runs under playwright.nginx.config.ts only (its mail catcher receives the reset email)');

  test('FR-ACC-06 FR-ACC-09 J-15: forgot password, link, new password, every old session ends', async ({ browser }) => {
    const a = (await buildOrg({ label: 'j15' })).members.assessor;
    const before = await newPage(browser);
    await signInPage(before, a);
    const cookies = await before.context().cookies();
    expect(cookies.some((c) => SESSION_COOKIE.test(c.name)), 'the browser holds a session cookie after sign-in').toBe(true);

    const page = await newPage(browser);
    await page.goto('/login');
    await page.getByRole('link', { name: SIGN_IN_COPY.forgotLink }).click();
    // A client-side navigation: wait for S-02 itself, or the fill can land in S-01's Email field on its way out.
    await page.waitForURL(/\/forgot-password$/);
    await expect(page.getByRole('heading', { level: 1, name: AUTH_COPY.resetHeading })).toBeVisible();
    await page.getByLabel(SIGN_IN_COPY.email).fill(a.email);
    await page.getByRole('button', { name: FORGOT_COPY.submit }).click();
    // The page's own status, not the shell's offline banner (also role="status").
    await expect(page.getByRole('status').filter({ hasText: AUTH_MESSAGE_COPY.resetLinkSent })).toHaveText(AUTH_MESSAGE_COPY.resetLinkSent);
    await expect.poll(() => mailedResetToken(a.email), { timeout: 15_000 }).not.toBeNull();
    const token = mailedResetToken(a.email)!;

    await page.goto(`/reset-password#token=${token}`);
    await page.getByLabel(RESET_COPY.newPassword).fill('j'.repeat(12));
    await page.getByRole('button', { name: RESET_COPY.submit }).click();
    await page.waitForURL(/\/login\?passwordChanged=1$/);

    await before.goto('/account');
    await expect(before).toHaveURL(/\/login/);
    await signInPage(page, { email: a.email, password: 'j'.repeat(12) });
    await page.goto('/account');
    await expect(page.getByRole('heading', { level: 1, name: ACCOUNT_COPY.page.heading })).toBeVisible();
    await expect.poll(() => readFileSync(process.env.E2E_MAIL_OUT!, 'utf8').includes(EMAIL_COPY.passwordChanged.subject), { timeout: 15_000 }).toBe(true);
  });

  test('NFR-A11Y-02: J-15 and sign-in complete with the keyboard alone, focus visible and uncovered', async ({ browser }) => {
    const a = (await buildOrg({ label: 'j15k' })).members.assessor;
    const page = await newPage(browser);
    await page.goto('/forgot-password');
    await tabTo(page, page.getByLabel(SIGN_IN_COPY.email));
    await page.keyboard.type(a.email);
    await tabTo(page, page.getByRole('button', { name: FORGOT_COPY.submit }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: AUTH_MESSAGE_COPY.resetLinkSent })).toBeVisible();
    // The form and its button are gone: focus is on the card's h1 above the answer, not in the live region (A-L1).
    await expect(page.getByRole('heading', { level: 1, name: AUTH_COPY.resetHeading })).toBeFocused();
    await expect.poll(() => mailedResetToken(a.email), { timeout: 15_000 }).not.toBeNull();

    await page.goto(`/reset-password#token=${mailedResetToken(a.email)!}`);
    await tabTo(page, page.getByLabel(RESET_COPY.newPassword));
    await page.keyboard.type('k'.repeat(12));
    await tabTo(page, page.getByRole('button', { name: RESET_COPY.submit }));
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/login\?passwordChanged=1$/);
    // The URL can change while S-01 still shows its Suspense fallback (LoginForm's useSearchParams boundary). Since the
    // logo became a plain <img> (NFR-PERF-02) that window was measured here, and a Tab pressed in it went to the footer.
    await expect(page.getByLabel(SIGN_IN_COPY.email)).toBeVisible();

    await tabTo(page, page.getByLabel(SIGN_IN_COPY.email));
    await page.keyboard.type(a.email);
    await tabTo(page, page.locator('#password'));
    await page.keyboard.type('k'.repeat(12));
    await page.keyboard.press('Enter');
    await page.waitForURL((url) => url.pathname !== '/login');
  });
});
