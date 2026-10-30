import { test, expect } from '@playwright/test';

test.describe('Security Hardening E2E', () => {

  test.describe('Input Validation', () => {
    test('registration rejects empty fields', async ({ page }) => {
      await page.goto('/register');
      // Submit empty form
      await page.locator('button[type="submit"]').click();
      // Should stay on register page with validation errors
      await expect(page).toHaveURL(/\/register/);
    });

    test('registration rejects short password', async ({ page }) => {
      await page.goto('/register');
      await page.fill('#name', 'Test');
      await page.fill('#email', `shortpw-${Date.now()}@test.com`);
      await page.fill('#password', 'abc');
      await page.fill('#confirmPassword', 'abc');
      await page.locator('input[type="checkbox"]').first().check();
      await page.locator('button[type="submit"]').click();

      // Should show validation error, stay on register page
      await expect(page).toHaveURL(/\/register/);
      // Check for error message (either form-level or field-level)
      const errorVisible = await page.locator('[role="alert"], .form-error, .error').first().isVisible().catch(() => false);
      expect(errorVisible).toBeTruthy();
    });

    test('registration rejects invalid email', async ({ page }) => {
      await page.goto('/register');
      await page.fill('#name', 'Test');
      await page.fill('#email', 'not-an-email');
      await page.fill('#password', 'SecurePass123!');
      await page.fill('#confirmPassword', 'SecurePass123!');
      await page.locator('input[type="checkbox"]').first().check();
      await page.locator('button[type="submit"]').click();

      // Should show error, stay on register page
      await expect(page).toHaveURL(/\/register/);
    });
  });

  test.describe('Authentication Security', () => {
    test('unauthenticated access redirects to login', async ({ page }) => {
      // `/dashboard` no longer exists (Task 6: the active org is a URL
      // segment) — `/` is the new entry point every authenticated session
      // lands on, and it redirects unauthenticated callers to `/login` via
      // the same requireIdentity() check the old `/dashboard` used.
      await page.goto('/');
      await expect(page).toHaveURL(/\/login/);
    });

    test('unauthenticated access to an org-scoped page redirects to login', async ({ page }) => {
      // The `/orgs/[slug]` layout calls requireIdentity() BEFORE resolving
      // the slug, so an unauthenticated caller is redirected to /login
      // regardless of whether `some-org` names a real organization.
      await page.goto('/orgs/some-org/projects');
      await expect(page).toHaveURL(/\/login/);
    });

    test('unauthenticated access to admin redirects to login', async ({ page }) => {
      await page.goto('/admin/users');
      await expect(page).toHaveURL(/\/login/);
    });

    test('wrong credentials show generic error', async ({ page }) => {
      await page.goto('/login');
      await page.fill('#email', 'nonexistent@test.com');
      await page.fill('#password', 'WrongPassword123!');
      await page.locator('button[type="submit"]').click();

      // Should stay on login page with error
      await expect(page).toHaveURL(/\/login/);
      // Wait a moment for error to appear
      await page.waitForTimeout(1000);
    });
  });

  test.describe('Security Headers', () => {
    test('API responses include rate limit headers', async ({ request }) => {
      const response = await request.get('/api/projects');
      // Even unauthorized, should have rate limit headers from middleware
      const headers = response.headers();
      expect(headers['x-ratelimit-limit']).toBeDefined();
      expect(headers['x-ratelimit-remaining']).toBeDefined();
    });

    // nginx is the single source of every security header (P3). This server runs
    // without nginx, so it must send none of them, and no framework banner either.
    // The headers themselves are guarded in the nginx config by
    // __tests__/lint/security-headers.test.ts, and on the live site by the
    // post-deploy curl check.
    test('pages send none of the security headers; nginx is their single source', async ({ request }) => {
      const headers = (await request.get('/login')).headers();
      for (const name of [
        'strict-transport-security',
        'content-security-policy',
        'x-frame-options',
        'x-content-type-options',
        'referrer-policy',
        'permissions-policy',
        'x-powered-by',
      ]) {
        expect(headers[name], `${name} must not come from the app`).toBeUndefined();
      }
    });
  });

  test.describe('Rate Limiting', () => {
    /**
     * D-195/D-199/D-200 (docs/DEFERRED_REGISTER.md). The test this replaced
     * asserted nothing under the exact condition it exists to observe: the
     * suite's OTHER specs already drive 10 registrations through the shared
     * default bucket (127.0.0.1 -- no test in this suite sets
     * `x-forwarded-for` except `auth.setup.ts` and this one), so by the time
     * this test ran, its own five requests were already refused with 429 --
     * and the old assertion only fired `if (remaining >= 0)`, which a 429's
     * `X-RateLimit-Remaining: '0'` satisfies, reducing the whole chain to
     * `0 <= Infinity` then `0 <= 0`, forever. It would have passed
     * identically whether the limiter worked, was absent, or refused every
     * request (see the Task 4 threat derivation, S1.1).
     *
     * EXPECTED_CAP is deliberately hand-written here, NOT imported from
     * `lib/rate-limit.ts`'s `RATE_LIMITS`. Importing it would recreate the
     * exact vacuity the derivation warns against ("a test reading
     * RATE_LIMITS[...].max discharges nothing") in a subtler form: it would
     * make this test track whatever value ships, silently, so a future
     * change to the config alone -- with no corresponding thought given to
     * THIS test -- would never be caught. Keeping it independent means a
     * change to one without the other fails this test loudly, at the wrong
     * boundary, forcing a conscious edit in both places -- which is also
     * exactly what stops a future "add a registering test, this goes red,
     * cheapest green is raising `max`" gradient from ever reaching this
     * test silently: bumping the config does not turn this green by itself.
     */
    const EXPECTED_CAP = 50;

    test(`exactly ${EXPECTED_CAP} registration attempts from one address succeed in a window, and attempt ${EXPECTED_CAP + 1} is refused`, async ({ request }) => {
      // Dedicated synthetic IP -- the identical pattern e2e/fixtures/auth.setup.ts
      // uses and whose reasoning the Task 4 derivation (S5) re-examined and
      // upheld: proxy.ts already trusts x-forwarded-for for exactly this
      // NAT-aware purpose, so giving this test its own address (a) isolates
      // it from every OTHER spec's registration traffic on the shared
      // default bucket, so this test's result depends only on requests IT
      // sends, not on suite size or run order, and (b) mirrors what N real
      // people behind one institutional NAT egress would actually present.
      // The last octet is derived from the current time so a retry of this
      // test within one run does not inherit the bucket its failed attempt
      // consumed. No bucket outlives a run: every run starts its own server
      // (`reuseExistingServer: false`, playwright.config.ts) and the limiter
      // is in memory (lib/rate-limit.ts).
      const ip = `198.51.100.${(Date.now() % 200) + 1}`;

      for (let i = 0; i < EXPECTED_CAP; i++) {
        const response = await request.post('/api/auth/register', {
          headers: { 'x-forwarded-for': ip },
          data: {
            name: 'Rate Test',
            orgName: `Rate Test Org ${i}`,
            email: `ratetest-${Date.now()}-${i}@test.com`,
            password: 'SecurePass123!',
            termsAccepted: true,
          },
        });
        // Both halves matter (D-191 entailment): asserting only the 201s
        // would pass for a limiter with no cap at all; asserting only an
        // eventual 429 (the old test's shape) passes under refusal from
        // request #1. This proves EXPECTED_CAP honest attempts succeed
        // through the REAL running proxy -> checkRateLimit -> RATE_LIMITS
        // chain -- not that the config file contains a number.
        expect(response.status(), `request #${i + 1} of ${EXPECTED_CAP} should succeed`).toBe(201);
        const remaining = parseInt(response.headers()['x-ratelimit-remaining'] ?? '-1', 10);
        expect(remaining, `remaining after request #${i + 1}`).toBe(EXPECTED_CAP - (i + 1));
      }

      // The (EXPECTED_CAP + 1)th request from the SAME address is refused.
      // This half is what an off-by-N, a removed cap, or a bucket keyed on
      // the wrong identifier would each fail to reproduce -- the "N succeed"
      // half above cannot distinguish any of those from a correct
      // implementation on its own.
      const overLimit = await request.post('/api/auth/register', {
        headers: { 'x-forwarded-for': ip },
        data: {
          name: 'Rate Test',
          orgName: 'Rate Test Org Overlimit',
          email: `ratetest-${Date.now()}-overlimit@test.com`,
          password: 'SecurePass123!',
          termsAccepted: true,
        },
      });
      expect(overLimit.status()).toBe(429);
      expect(overLimit.headers()['x-ratelimit-remaining']).toBe('0');

      // Gap named, not closed (D-191): this proves the ERGONOMICS property
      // -- the configured number is enforced end-to-end for a single stable
      // identifier, through the real HTTP stack. It proves nothing about the
      // ADVERSARIAL axis: a caller who varies x-forwarded-for per request
      // defeats this control entirely (live-confirmed outside this suite,
      // Task 4 derivation S2.2; not re-proven here because doing so would
      // create real accounts from spoofed addresses against a shared dev
      // database on every CI run, which is its own hazard). That gap is
      // D-199 (trusted-proxy allowlist) and D-200 (email verification),
      // docs/DEFERRED_REGISTER.md.
    });
  });
});
