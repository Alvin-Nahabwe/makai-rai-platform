import { test, expect } from '@playwright/test';

test.describe('Security Hardening E2E', () => {

  // The /register form and its validation cases are gone with the open sign-up path (FR-ACC-01):
  // e2e/acceptances.spec.ts checks that POST /api/auth/register and GET /register answer 404, and
  // S-04's own name and password checks.

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
});
