import { test, expect } from '@playwright/test';

test.describe('Authentication Flow', () => {
  const testUser = {
    name: 'Test User',
    email: `test-${Date.now()}@test.com`,
    password: 'SecurePass123!',
  };

  test('register a new user and login', async ({ page }) => {
    // --- Registration ---
    await page.goto('/register');
    await expect(page.locator('h1')).toHaveText('Create Account');

    // Fill registration form
    await page.fill('#name', testUser.name);
    await page.fill('#email', testUser.email);
    await page.fill('#password', testUser.password);
    await page.fill('#confirmPassword', testUser.password);

    // Accept terms checkbox (required)
    await page.locator('input[type="checkbox"]').first().check();

    // Submit registration
    await page.locator('button[type="submit"]').click();

    // Verify redirect to login with success indicator
    await page.waitForURL('**/login?registered=true');
    await expect(page.locator('[role="status"]')).toHaveText(
      'Account created. Please sign in.',
    );

    // --- Login ---
    await page.fill('#email', testUser.email);
    await page.fill('#password', testUser.password);
    await page.locator('button[type="submit"]').click();

    // Verify redirect to dashboard
    await page.waitForURL('**/dashboard');

    // Verify welcome message contains the user name
    await expect(page.locator('h1')).toContainText(testUser.name);
  });
});
