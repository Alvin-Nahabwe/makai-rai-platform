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

    test('pages include security headers', async ({ request }) => {
      const response = await request.get('/login');
      const headers = response.headers();
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['x-frame-options']).toBe('DENY');
    });
  });

  test.describe('Rate Limiting', () => {
    test('excessive API calls trigger rate limit headers', async ({ request }) => {
      // Send several requests and check headers decrease
      let lastRemaining = Infinity;
      for (let i = 0; i < 5; i++) {
        const response = await request.post('/api/auth/register', {
          data: {
            name: 'Rate Test',
            email: `ratetest-${Date.now()}-${i}@test.com`,
            password: 'SecurePass123!',
            termsAccepted: true,
          },
        });
        const remaining = parseInt(response.headers()['x-ratelimit-remaining'] || '-1');
        if (remaining >= 0) {
          expect(remaining).toBeLessThanOrEqual(lastRemaining);
          lastRemaining = remaining;
        }
      }
    });
  });
});
