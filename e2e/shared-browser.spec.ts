import 'dotenv/config';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { buildOrg, type FixtureAccount, type OrgFixture } from '../__tests__/helpers/recordFixture';
import { draftKeys, signInWith } from './helpers/session';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { AUTH_COPY } from '../lib/auth/copy';
import { ACCEPTANCES_COPY } from '../lib/legal/acceptances/copy';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { FIELD_COPY } from '../lib/ui/field/copy';
import { closeOpenedContexts } from './helpers/contexts';

// Every context a test opened is closed after it (helpers/contexts.ts says why).
test.afterEach(closeOpenedContexts);

/**
 * D16, option A (plan 1B Task 5; owner's answer to OD-1, 11 Nov 2026): on a shared browser, a second account that signs in
 * is told that another account's unsaved text is kept here, and chooses: sign out and leave it for its owner, or remove it
 * and go on (today's purge). The question names nobody and counts nothing (T5.2); one's own text never raises it (Review
 * Focus 1). Accounts are made per test with buildOrg; each context signs in from its own client address.
 */
let ipSeq = 0;
async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': `10.73.0.${++ipSeq}` } });
  return context.newPage();
}

/** A draft as the store writes it, saved now. */
const DRAFT = () => JSON.stringify({ baseVersionNumber: null, value: { reason: 'left by the first account' }, savedAt: new Date().toISOString(), savePressedAt: null, retry: { requestId: null, sentBody: null } });
const keyOf = (fx: OrgFixture, userId: string) => `makrai.draft.v1:${userId}:${fx.org.id}:p1:q:Q-PP-01`;

/** Fills S-01 and presses Sign in, without the shared helper's answer to the question. */
async function pressSignIn(page: Page, account: Pick<FixtureAccount, 'email' | 'password'>): Promise<void> {
  if (!/\/login(\?|$)/.test(page.url())) await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await expect(async () => {
    await page.fill('#email', account.email);
    await page.fill('#password', account.password);
    await expect(page.locator('#password')).toHaveValue(account.password, { timeout: 100 });
  }).toPass({ timeout: 20_000 });
  await page.locator('button[type="submit"]').click();
}

/** The question is the page's h1 once the sign-in has worked (ruling L5-27). */
const question = (page: Page) => page.getByRole('heading', { level: 1, name: AUTH_COPY.otherTextTitle });

test.describe('D16: unsaved text of another account on a shared browser', () => {
  test('D16: a second account is warned before the first account\'s text is removed, and the warning names nobody', async ({ browser }) => {
    const fx = await buildOrg({ label: 'd16warn' });
    const a = fx.members.assessor;
    const b = fx.members.reviewer;
    const page = await newPage(browser);
    await page.goto('/login');
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [keyOf(fx, a.userId), DRAFT()] as const);
    await pressSignIn(page, b);
    await expect(question(page)).toBeVisible();
    await expect(page.locator('.other-text')).toHaveText(
      `${AUTH_COPY.otherTextBody}${AUTH_COPY.signOutAndLeave}: ${AUTH_COPY.consequenceLeave}${AUTH_COPY.removeAndContinue}: ${AUTH_COPY.consequenceRemove}${AUTH_COPY.signOutAndLeave}${AUTH_COPY.removeAndContinue}`,
    );
    // The route says the sign-in is done and the question is where the person is (ruling L5-27).
    await expect(page.locator('[aria-current="step"]')).toContainText(AUTH_COPY.loginStops.unsavedText);
    expect(new URL(page.url()).pathname).toBe('/login');
    const content = await page.content();
    for (const secret of [a.email, a.name, a.userId, fx.org.name, fx.org.slug, 'left by the first account']) expect(content, secret).not.toContain(secret);
    // Nothing was removed while the question stands.
    expect(await draftKeys(page, a.userId)).toEqual([keyOf(fx, a.userId)]);
    await page.context().close();
  });

  test('D16: Sign out and leave it keeps A\'s key; A signs in and finds the reason text on the question', async ({ browser }) => {
    test.setTimeout(120_000);
    const fx = await buildOrg({ label: 'd16leave' });
    const a = fx.members.assessor;
    const b = fx.members.reviewer;
    const page = await newPage(browser);
    await page.goto('/login');
    await signInWith(page, a.email, a.password);
    const res = await page.request.post(`/api/v1/orgs/${fx.org.slug}/projects`, { data: { requestId: crypto.randomUUID(), name: `D16 ${Date.now()}`, aiSystemType: 'classification' } });
    expect(res.status(), 'project create').toBe(201);
    const { id } = (await res.json()) as { id: string };
    const path = `/orgs/${fx.org.slug}/projects/${id}/stages/pre-processing/questions/Q-PP-01`;
    const reason = page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`);
    await page.goto(path);
    await page.waitForFunction(() => document.querySelector('[data-region="answer-form"] form')?.getAttribute('data-ready') === 'true');
    await reason.fill('A typed this and left the room');
    await expect.poll(() => draftKeys(page, a.userId)).toHaveLength(1);
    const aKeys = await draftKeys(page, a.userId);
    // A walks away without signing out, and the session ends (an idle sign-out runs no client code).
    await page.context().clearCookies();

    await pressSignIn(page, b);
    await expect(question(page)).toBeVisible();
    await page.getByRole('button', { name: AUTH_COPY.signOutAndLeave }).click();
    // The question is on /login already, so the address cannot say the sign-out finished: S-01's form coming back can.
    await expect(page.locator('#email')).toBeVisible({ timeout: 30_000 });
    await expect(question(page)).toHaveCount(0);
    expect(await draftKeys(page, a.userId)).toEqual(aKeys);
    // B is signed out: a signed-in page sends B to S-01.
    await page.goto('/account');
    await expect(page).toHaveURL(/\/login/);

    await page.goto('/login');
    await signInWith(page, a.email, a.password);
    await page.goto(path);
    await page.waitForFunction(() => document.querySelector('[data-region="answer-form"] form')?.getAttribute('data-ready') === 'true');
    await expect(reason).toHaveValue('A typed this and left the room');
    await page.context().close();
  });

  test('D16: Remove it and continue leaves only B\'s keys', async ({ browser }) => {
    const fx = await buildOrg({ label: 'd16remove' });
    const a = fx.members.assessor;
    const b = fx.members.reviewer;
    const page = await newPage(browser);
    await page.goto('/login');
    await page.evaluate(([ka, kb, v, la]) => {
      localStorage.setItem(ka, v); localStorage.setItem(kb, v); localStorage.setItem(la, 'p1');
    }, [keyOf(fx, a.userId), keyOf(fx, b.userId), DRAFT(), `makrai:last-project:${a.userId}:${fx.org.slug}`] as const);
    await pressSignIn(page, b);
    await page.getByRole('button', { name: AUTH_COPY.removeAndContinue }).click();
    await page.waitForURL((url) => url.pathname !== '/login');
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('makrai.draft.v1:') || k.startsWith('makrai:last-project:')));
    expect(keys).toEqual([keyOf(fx, b.userId)]);
    await page.context().close();
  });

  test('D16: one\'s own unsaved text never triggers the warning and is restored', async ({ browser }) => {
    const fx = await buildOrg({ label: 'd16own' });
    const a = fx.members.assessor;
    const page = await newPage(browser);
    await page.goto('/login');
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [keyOf(fx, a.userId), DRAFT()] as const);
    // Whether the question ever appeared on S-01, kept in this tab's sessionStorage across the navigation that follows.
    await page.addInitScript((title) => {
      new MutationObserver(() => {
        if (document.body?.textContent?.includes(title)) sessionStorage.setItem('d16-probe-asked', '1');
      }).observe(document, { childList: true, subtree: true, characterData: true });
    }, AUTH_COPY.otherTextTitle);
    await page.reload();
    await pressSignIn(page, a);
    await page.waitForURL((url) => url.pathname !== '/login', { timeout: 30_000 });
    expect(await page.evaluate(() => sessionStorage.getItem('d16-probe-asked'))).toBeNull();
    expect(await draftKeys(page, a.userId)).toEqual([keyOf(fx, a.userId)]);
    await page.context().close();
  });

  test('D16: axe and keyboard: focus moves to the confirmation\'s title; Tab reaches the choices in order', async ({ browser }) => {
    const fx = await buildOrg({ label: 'd16a11y' });
    const a = fx.members.assessor;
    const b = fx.members.reviewer;
    const page = await newPage(browser);
    await page.goto('/login');
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [keyOf(fx, a.userId), DRAFT()] as const);
    await pressSignIn(page, b);
    await expect(question(page)).toBeVisible();
    await expect(question(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: AUTH_COPY.signOutAndLeave })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: AUTH_COPY.removeAndContinue })).toBeFocused();
    await expectNoSeriousA11yViolations(page, 'D16 confirmation');
    // Escape chooses nothing: the question stays, and the text with it (T5.8).
    await page.keyboard.press('Escape');
    await expect(question(page)).toBeVisible();
    expect(await draftKeys(page, a.userId)).toEqual([keyOf(fx, a.userId)]);
    await page.context().close();
  });

  test('D16 (L5-11): Sign out and leave it when the CSRF token cannot be fetched stays, says still signed in, keeps the text, and the retry works', async ({ browser }) => {
    const fx = await buildOrg({ label: 'd16csrf' });
    const a = fx.members.assessor;
    const b = fx.members.reviewer;
    const page = await newPage(browser);
    await page.goto('/login');
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [keyOf(fx, a.userId), DRAFT()] as const);
    await pressSignIn(page, b);
    await expect(question(page)).toBeVisible();
    const CSRF = /\/api\/auth\/csrf(\?|$)/;
    await page.route(CSRF, (r) => r.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }));
    await page.getByRole('button', { name: AUTH_COPY.signOutAndLeave }).click();
    await expect(page.getByRole('alert').filter({ hasText: ACCEPTANCES_COPY.stillSignedIn })).toBeVisible({ timeout: 30_000 });
    await expect(question(page)).toBeVisible();
    expect(new URL(page.url()).searchParams.has('error')).toBe(false);
    expect(await draftKeys(page, a.userId)).toEqual([keyOf(fx, a.userId)]);
    const res = await page.request.get('/account', { maxRedirects: 0 });
    expect(res.status(), 'still signed in, as the line says').toBe(200);

    await page.unroute(CSRF);
    await page.getByRole('button', { name: AUTH_COPY.signOutAndLeave }).click();
    await expect(page.locator('#email')).toBeVisible({ timeout: 30_000 });
    expect(await draftKeys(page, a.userId)).toEqual([keyOf(fx, a.userId)]);
    await page.goto('/account');
    await expect(page).toHaveURL(/\/login/);
    await page.context().close();
  });
});
