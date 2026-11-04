import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';

/**
 * Project creation by a signed-in member. The member is a fixture seat (e2e/fixtures/auth.setup.ts,
 * K0a's buildTwoOrgFixture) with its saved session: accounts come only from invitations (FR-ACC-01).
 */
const manifest: FixtureManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

test.describe('Project Creation Flow', () => {
  test('create a new project after login', async ({ browser }) => {
    const seat = manifest.users.find((u) => u.role === 'owner' && u.index === 1);
    if (!seat) throw new Error('project.spec: no owner seat in the fixture manifest');
    const context = await browser.newContext({ storageState: seat.storageStatePath });
    const page = await context.newPage();
    const orgSlug = seat.orgSlug;

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
    // and this assertion could observe the stale form page. The pattern
    // below excludes `/new` explicitly.
    await page.waitForURL(/\/orgs\/[a-z0-9-]+\/projects\/(?!new$)[a-zA-Z0-9-]+$/);
    // The URL should NOT be /projects/new anymore
    expect(page.url()).not.toContain('/projects/new');

    // Verify the project name appears on the page
    await expect(page.locator('body')).toContainText(projectName);
    await context.close();
  });
});
