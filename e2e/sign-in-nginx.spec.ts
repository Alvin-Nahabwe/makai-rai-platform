import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test, expect, request as playwrightRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import { buildOrg, type FixtureMember } from '../__tests__/helpers/recordFixture';

/**
 * Sign-in through the production nginx configuration (SRS FR-ACC-05, NFR-SEC-06 "Verified by"; FR-ACC-06; NFR-SEC-07;
 * obligations B4, B5, B6, B9, B13). Run only by playwright.nginx.config.ts, which starts the mail catcher, the app on
 * `next start` (NEXTAUTH_URL https://makrai.org, Resend pointed at the catcher) and nginx from scripts/nginx-test/up.sh,
 * and sets E2E_MAIL_OUT; under the default config both variables are unset and the whole file is skipped.
 *
 * Every request goes to E2E_NGINX_URL (https://127.0.0.1:<8440+K>) with `Host: makrai.org`: nginx serves that one name
 * and refuses a handshake without it (default.conf's default_server, `ssl_reject_handshake on`), and Node's HTTPS
 * client takes the TLS server name from the Host header when the URL is an address. All requests come from one client
 * address, which is the point: nothing may limit sign-in by it. The certificate is up.sh's self-signed one.
 */
const NGINX = process.env.E2E_NGINX_URL ?? '';
const MAIL_OUT = process.env.E2E_MAIL_OUT ?? '';
const K = Number(/:(\d+)$/.exec(NGINX)?.[1] ?? '8440') - 8440;
const CONTAINER = `v060-nginx-b${K}`;

async function client(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: NGINX, ignoreHTTPSErrors: true, extraHTTPHeaders: { Host: 'makrai.org' } });
}

/** The three requests a browser's sign-in makes: the CSRF token, the credentials POST, and the session read. */
async function signIn(c: APIRequestContext, email: string, password: string): Promise<{ post: APIResponse; session: unknown }> {
  const { csrfToken } = (await (await c.get('/api/auth/csrf')).json()) as { csrfToken: string };
  const post = await c.post('/api/auth/callback/credentials', {
    form: { csrfToken, email, password, callbackUrl: 'https://makrai.org/' },
    headers: { 'X-Auth-Return-Redirect': '1' },
    maxRedirects: 0,
  });
  const session = await (await c.get('/api/auth/session')).json();
  return { post, session };
}

/** The last E-03 the catcher received for `email`, and the token after '#token=' in its text. */
function resetTokenFor(email: string): string {
  const lines = readFileSync(MAIL_OUT, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; to: unknown; text?: string });
  const mail = lines.filter((l) => l.kind === 'email' && JSON.stringify(l.to).includes(email)).at(-1);
  const token = mail?.text ? /#token=([0-9a-f]{64})/.exec(mail.text)?.[1] : undefined;
  if (!token) throw new Error('no reset email with a token reached the mail catcher');
  return token;
}

test.describe('through nginx', { tag: '@nginx' }, () => {
  test.skip(!NGINX || !MAIL_OUT, 'runs under playwright.nginx.config.ts only (it sets E2E_NGINX_URL and E2E_MAIL_OUT)');

  let accounts: FixtureMember[] = [];

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    // The config's port wait only proves a TCP accept; wait for the first answer through nginx, for at most 30 s.
    const c = await client();
    const deadline = Date.now() + 30_000;
    let first: string | null = null;
    while (Date.now() < deadline) {
      try {
        const r = await c.get('/api/health', { timeout: 5_000 });
        if (r.status() === 200) { first = `${r.status()} ${await r.text()}`; break; }
      } catch { /* not answering yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    await c.dispose();
    if (!first) throw new Error('GET /api/health through nginx did not answer 200 within 30 s');
    console.log(`first /api/health answer through nginx: ${first}`);
    // 61 accounts and a few spare, five a fixture organisation.
    for (let i = 0; i < 14; i++) accounts.push(...Object.values((await buildOrg({ label: `ngx${i}` })).members));
  });

  test.afterAll(async () => {
    accounts = [];
    await testDb.$disconnect();
  });

  test('FR-ACC-05 NFR-SEC-06: 61 accounts sign in from one address through nginx within a minute', async () => {
    test.setTimeout(120_000);
    const t0 = Date.now();
    for (const a of accounts.slice(0, 61)) {
      const c = await client();
      const { session } = await signIn(c, a.email, a.password);
      expect((session as { user?: { id?: string } } | null)?.user?.id, a.email).toBe(a.userId);
      await c.dispose();
    }
    expect(Date.now() - t0).toBeLessThan(60_000);
  });

  test('FR-ACC-05 NFR-SEC-06: 20 wrong passwords at once lock one account; the right one is then refused', async () => {
    const a = accounts[61];
    const contexts = await Promise.all(Array.from({ length: 20 }, () => client()));
    await Promise.all(contexts.map((c) => signIn(c, a.email, 'wrong-password-x')));
    const u = await testDb.user.findUniqueOrThrow({ where: { id: a.userId } });
    expect(u.lockedUntil?.getTime() ?? 0).toBeGreaterThan(Date.now());
    const c = await client();
    expect((await signIn(c, a.email, a.password)).session).toBeNull();
    for (const x of [...contexts, c]) await x.dispose();
  });

  test('NFR-SEC-06: the three refusals are byte-identical through nginx', async () => {
    const wrong = accounts[62];
    const locked = accounts[63];
    await testDb.user.update({ where: { id: locked.userId }, data: { failedLoginAttempts: 5, lockedUntil: new Date(Date.now() + 15 * 60_000) } });
    const answers: Array<[number, string]> = [];
    for (const [email, password] of [[wrong.email, 'wrong-password-x'], [locked.email, locked.password], ['nobody@fixture.test', 'x']]) {
      const c = await client();
      const { post } = await signIn(c, email, password);
      answers.push([post.status(), await post.text()]);
      await c.dispose();
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  test('FR-ACC-05: with 50 sign-ins at once, /api/health answers within 500 ms at the 95th percentile', async () => {
    test.setTimeout(120_000);
    const signIns = accounts.slice(0, 50).map(async (a) => {
      const c = await client();
      await signIn(c, a.email, a.password); // a 503 sign_in_busy is an answer, not a throw, under this load
      await c.dispose();
    });
    const health = await client();
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const s = Date.now();
      expect((await health.get('/api/health')).status()).toBe(200);
      times.push(Date.now() - s);
    }
    await Promise.all(signIns);
    await health.dispose();
    const p95 = [...times].sort((x, y) => x - y)[94];
    console.log(`/api/health p95 during 50 sign-ins: ${p95} ms`);
    expect(p95).toBeLessThan(500);
  });

  test('NFR-SEC-07: the session cookie is HttpOnly, Secure and SameSite=Lax', async () => {
    const a = accounts[0];
    const c = await client();
    const { post } = await signIn(c, a.email, a.password);
    const cookies = post.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
    const session = cookies.find((v) => /^__Secure-authjs\.session-token=[^;]+/.test(v));
    expect(session, 'a __Secure- session cookie is set').toBeTruthy();
    const attrs = session!.split(';').map((s) => s.trim().toLowerCase());
    expect(attrs).toEqual(expect.arrayContaining(['httponly', 'secure', 'samesite=lax']));
    await c.dispose();
  });

  test('FR-ACC-06 NFR-OBS-01: the captured nginx log holds no reset token', async () => {
    const a = accounts[1];
    const c = await client();
    expect((await c.post('/api/password-reset', { data: { email: a.email } })).status()).toBe(202);
    let token = '';
    await expect.poll(() => { try { token = resetTokenFor(a.email); return true; } catch { return false; } }, { timeout: 15_000 }).toBe(true);
    expect((await c.post('/api/password-reset/complete', { data: { token, newPassword: 'n'.repeat(12) } })).status()).toBe(204);
    await c.dispose();
    const logs = execFileSync('docker', ['logs', CONTAINER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(logs).toContain('/api/password-reset/complete');
    expect(logs).not.toMatch(/[0-9a-f]{64}/);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain('@');
  });
});
