import { test, expect, Page } from '@playwright/test';

/**
 * Helper: register a new user and log in, returning the generated credentials.
 */
async function registerAndLogin(page: Page) {
  const user = {
    name: 'Project Test User',
    email: `project-test-${Date.now()}@test.com`,
    password: 'SecurePass123!',
  };

  // Register
  await page.goto('/register');
  await page.fill('#name', user.name);
  await page.fill('#email', user.email);
  await page.fill('#orgName', 'Project Test Org');
  await page.fill('#password', user.password);
  await page.fill('#confirmPassword', user.password);
  await page.locator('input[type="checkbox"]').first().check();
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/login?registered=true');

  // Login
  await page.fill('#email', user.email);
  await page.fill('#password', user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/dashboard');

  return user;
}

test.describe('Project Creation Flow', () => {
  test('create a new project after login', async ({ page }) => {
    await registerAndLogin(page);

    // Navigate to new project page
    await page.goto('/projects/new');
    await expect(page.locator('h1')).toHaveText('New Project');

    // Fill project form
    const projectName = `E2E Test Project ${Date.now()}`;
    await page.fill('#name', projectName);
    await page.selectOption('#aiSystemType', 'classification');

    // Submit
    await page.locator('button[type="submit"]').click();

    // Verify redirect to project detail page (/projects/<uuid>)
    await page.waitForURL('**/projects/**');
    // The URL should NOT be /projects/new anymore
    expect(page.url()).not.toContain('/projects/new');

    // Verify the project name appears on the page
    await expect(page.locator('body')).toContainText(projectName);
  });
});
