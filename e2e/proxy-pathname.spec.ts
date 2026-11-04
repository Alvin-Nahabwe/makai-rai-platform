import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import { buildOrg } from '../__tests__/helpers/recordFixture';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';

/**
 * UX-01 (7.1.2: the gates run on every page request; gate 2 is must-change-password): `x-pathname` is the proxy's value or
 * it is absent, never the client's. `requireIdentity()` lets a must-change-password account stay only on /change-password,
 * and it reads the page it is on from that header. The proxy used to skip every path that ends in .png, .jpg, .jpeg, .svg,
 * .ico or .webp. The exploit path is one that a dynamic segment takes, such as `/orgs/<slug>/projects/missing.png`: it
 * runs `(authenticated)/layout.tsx` and `requireIdentity()` before the page answers not-found, so a client's own
 * `x-pathname: /change-password` walked past the gate and the signed-in shell rendered. A path no route matches
 * (`/does-not-exist.png`) gets the root not-found page, which has no identity gate. The matcher now covers every path
 * except `_next/static` and `_next/image` (proxy.ts), the proxy overwrites whatever the client sent on a page path, and for
 * `/api/*` it removes the client's value.
 *
 * The seat is the second viewer of the second organisation: no other spec signs in as it, so flagging it for the length of
 * this test does not change what a spec running beside this one sees. The flag is cleared in a `finally`.
 */
const manifest: FixtureManifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const org = manifest.orgs[1];
const seat = manifest.users.find((u) => u.orgSlug === org.slug && u.role === 'viewer' && u.index === 1);
if (!seat) throw new Error(`proxy-pathname: no second viewer seat for ${org.slug} in the fixture manifest`);

test.afterAll(async () => {
  await testDb.$disconnect();
});

test('UX-01: a must-change-password account cannot skip the gate with a forged x-pathname on an image path', async ({ browser }) => {
  const context = await browser.newContext({ storageState: seat.storageStatePath });
  try {
    await testDb.user.update({ where: { id: seat.userId }, data: { mustChangePassword: true } });
    const forged = { 'x-pathname': '/change-password' };
    // A project id may end in any extension, so these paths reach `(authenticated)/layout.tsx` (which calls
    // requireIdentity() before the page looks the project up and answers not-found), and used to skip the proxy.
    for (const ext of ['png', 'jpg', 'jpeg', 'svg', 'ico', 'webp']) {
      const path = `/orgs/${org.slug}/projects/missing.${ext}`;
      const res = await context.request.get(path, { headers: forged, maxRedirects: 0 });
      const body = await res.text();
      // Not the signed-in shell: its sidebar and main landmark are absent.
      expect(body, path).not.toContain('app-layout');
      expect(body, path).not.toContain('Main navigation');
      expect(body, path).not.toContain('app-main');
      // The gate ran: the account is sent to /change-password.
      expect(res.status(), path).toBe(307);
      expect(res.headers().location ?? '', path).toMatch(/\/change-password$/);
    }
    // A path no route matches answers the plain not-found page, never the shell, whatever the header says.
    const missing = await context.request.get('/does-not-exist.png', { headers: forged, maxRedirects: 0 });
    expect(missing.status()).toBe(404);
    expect(await missing.text()).not.toContain('app-layout');
    // The same request with the true path is unchanged.
    const own = await context.request.get('/change-password', { maxRedirects: 0 });
    expect(own.status()).toBe(200);
  } finally {
    await testDb.user.update({ where: { id: seat.userId }, data: { mustChangePassword: false } });
    await context.close();
  }
});

test('UX-01 FR-ACC-04: an account missing an acceptance cannot skip gate 3 with a forged x-pathname on an image path', async ({ browser }) => {
  // Gate 3 exempts only /acceptances and /account by exact x-pathname (lib/auth/identity.ts); a client's own
  // `x-pathname: /account` on a dynamic-segment image path used to reach requireIdentity() untouched.
  const fx = await buildOrg({ label: 'pxaccept', acceptances: 'pre-v1' });
  const account = fx.members.owner;
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '10.48.0.1' } });
  try {
    const login = await context.newPage();
    await login.goto('/login');
    await login.fill('#email', account.email);
    await login.fill('#password', account.password);
    await login.locator('button[type="submit"]').click();
    await login.waitForURL((url) => url.pathname !== '/login');
    await login.close();
    for (const ext of ['png', 'svg']) {
      const path = `/orgs/${fx.org.slug}/projects/missing.${ext}`;
      const res = await context.request.get(path, { headers: { 'x-pathname': '/account' }, maxRedirects: 0 });
      const body = await res.text();
      expect(body, path).not.toContain('app-layout');
      expect(body, path).not.toContain('Main navigation');
      expect(res.status(), path).toBe(307);
      expect(res.headers().location ?? '', path).toMatch(/\/acceptances$/);
    }
  } finally {
    await context.close();
  }
});
