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

  // Task 6: the active org is a URL segment, not ambient session state. A
  // first-time login has no remembered org yet (lastActiveOrgId is unset —
  // D-069), so `/` shows the org picker rather than redirecting straight to
  // a dashboard.
  await page.waitForURL('**/');
  await page.getByRole('link', { name: 'Project Test Org' }).click();
  await page.waitForURL(/\/orgs\/[a-z0-9-]+\/dashboard$/);

  return user;
}

test.describe('Project Creation Flow', () => {
  test('create a new project after login', async ({ page }) => {
    await registerAndLogin(page);
    const orgSlug = new URL(page.url()).pathname.split('/')[2];

    // Navigate to new project page
    await page.goto(`/orgs/${orgSlug}/projects/new`);
    await expect(page.locator('h1')).toHaveText('New Project');

    // Fill project form
    const projectName = `E2E Test Project ${Date.now()}`;
    await page.fill('#name', projectName);
    await page.selectOption('#aiSystemType', 'classification');

    // Submit
    await page.locator('button[type="submit"]').click();

    // Verify redirect to the project detail page
    // (/orgs/<slug>/projects/<uuid>). A bare `**/projects/**` wildcard
    // ALSO matches the form page itself (`/orgs/<slug>/projects/new`
    // contains "/projects/"), so it resolved immediately pre-navigation
    // and this assertion could observe the stale form page — a latent bug
    // in the test, exposed now that project creation actually succeeds
    // (D-070 fixed). The pattern below excludes `/new` explicitly.
    await page.waitForURL(/\/orgs\/[a-z0-9-]+\/projects\/(?!new$)[a-zA-Z0-9-]+$/);
    // The URL should NOT be /projects/new anymore
    expect(page.url()).not.toContain('/projects/new');

    // Verify the project name appears on the page
    await expect(page.locator('body')).toContainText(projectName);
  });
});
