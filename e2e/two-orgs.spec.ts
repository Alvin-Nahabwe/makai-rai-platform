import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import type { OrgRole } from '@prisma/client';
import { can } from '../lib/authz/policy';
import { FIXTURE_ROLES } from '../__tests__/helpers/fixture';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';

/**
 * Task 12 Step 2.
 *
 * TWO ORGS, INDEPENDENTLY CREATED — NOT ONE ORG WITH TWO MEMBERS. The
 * fixture's two orgs (`__tests__/helpers/fixture.ts#buildOrg`) are each
 * bootstrapped by their OWN owner through `bootstrapOrgWithOwner` — "the
 * same function `/api/auth/register` calls" (that module's own doc) — with
 * every other seat added afterwards by invitation. That is structurally
 * the thing this gate requires: two disjoint orgs, not one org holding
 * every role. The literal browser `/register` form submission for this
 * exact path is already covered live by `e2e/org-routing.spec.ts`
 * ("/ shows the org picker...", "a member of org A gets 404 on org B") —
 * not duplicated here. What THIS file adds is the part that spec does not
 * cover: isolation proven for EVERY role, in BOTH directions, not just an
 * owner-vs-owner pair — the exact gap the brief calls out ("at any role,
 * including owner").
 *
 * FIXTURE, NOT A FRESH ONE (brief constraint 1): all 10 role checks below
 * reuse the 20-seat fixture's storageStates. The one place this file DOES
 * perform a fresh registration is the invitation walk (Step 2's second
 * requirement), because moving a brand-new third person into an org THROUGH
 * THE REAL UI is the thing under test there and cannot be proven any other
 * way — it is exactly one fresh login, not twenty.
 */

const manifest: FixtureManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

function seat(orgSlug: string, role: OrgRole, index: 0 | 1 = 0): FixtureManifestUser {
  const found = manifest.users.find(
    (u) => u.orgSlug === orgSlug && u.role === role && u.index === index,
  );
  if (!found) throw new Error(`two-orgs: no fixture seat for ${orgSlug}/${role}/${index}`);
  return found;
}

const [orgA, orgB] = manifest.orgs;

test.describe('cross-org isolation, every role, both directions', () => {
  // STATIC labels in the title, deliberately not the slugs themselves —
  // see role-matrix.spec.ts's matching comment: the fixture's org slugs
  // are re-randomized per run, and a title that embeds them mismatches
  // between Playwright's list-time load and each worker's run-time
  // reload of this file (once `setup` has rewritten manifest.json),
  // which fails every test with "Test not found in the worker process".
  for (const [home, other, homeLabel, otherLabel] of [
    [orgA, orgB, 'A', 'B'],
    [orgB, orgA, 'B', 'A'],
  ] as const) {
    for (const role of FIXTURE_ROLES) {
      test(`org ${homeLabel}/${role} gets 404 reaching org ${otherLabel} by direct URL`, async ({ browser }) => {
        const user = seat(home.slug, role);
        const context = await browser.newContext({ storageState: user.storageStatePath });
        const page = await context.newPage();

        const res = await page.goto(`/orgs/${other.slug}/dashboard`);
        expect(res?.status()).toBe(404);

        // Settings/members too — a second route class, same org boundary.
        const res2 = await page.goto(`/orgs/${other.slug}/settings/members`);
        expect(res2?.status()).toBe(404);

        await context.close();
      });
    }
  }
});

test.describe('an invitation moves a third person into an org, at the invited role', () => {
  test('a brand-new person accepts a live invitation into org A as assessor', async ({ browser }) => {
    const owner = seat(orgA.slug, 'owner');
    const thirdEmail = `two-orgs-third-${Date.now()}-${Math.random().toString(36).slice(2)}@fixture.test`;
    const thirdPassword = 'ThirdPersonPass123!';

    // --- Step A: the owner invites a fresh email as `assessor` through the
    // real MembersManager UI (component doc: every button here is a UX
    // nicety over the server's own `can()` gate, but the INVITE itself is
    // the write under test here).
    const ownerContext = await browser.newContext({ storageState: owner.storageStatePath });
    const ownerPage = await ownerContext.newPage();
    await ownerPage.goto(`/orgs/${orgA.slug}/settings/members`);
    await ownerPage.fill('#invite-email', thirdEmail);
    await ownerPage.selectOption('#invite-role', 'assessor');
    await ownerPage.getByRole('button', { name: 'Invite' }).click();

    const acceptLink = ownerPage.locator('a[href*="/invitations/"]').first();
    await expect(acceptLink).toBeVisible();
    const acceptUrl = await acceptLink.getAttribute('href');
    expect(acceptUrl).toBeTruthy();
    await ownerContext.close();

    // --- Step B: an entirely anonymous browser context (no storageState —
    // this person has never touched the app before) follows the one-time
    // link, registers, logs in, and accepts — the real
    // AcceptInvitationClient three-branch flow, anonymous branch.
    const thirdContext = await browser.newContext();
    const thirdPage = await thirdContext.newPage();

    await thirdPage.goto(acceptUrl!);
    await expect(thirdPage.locator('h1')).toHaveText("You're invited");
    await expect(thirdPage.locator('body')).toContainText(thirdEmail);
    await expect(thirdPage.locator('body')).toContainText('assessor');

    await thirdPage.getByRole('button', { name: `Create an account as ${thirdEmail}` }).click();
    await thirdPage.fill('#inv-name', 'Two Orgs Third Person');
    await thirdPage.fill('#inv-password', thirdPassword);
    await thirdPage.fill('#inv-confirmPassword', thirdPassword);
    await thirdPage.locator('input[type="checkbox"]').first().check();
    await thirdPage.getByRole('button', { name: 'Create Account' }).click();

    await thirdPage.waitForURL('**/login?registered=true**');
    await thirdPage.fill('#email', thirdEmail);
    await thirdPage.fill('#password', thirdPassword);
    await thirdPage.locator('button[type="submit"]').click();

    // callbackUrl carries them back to the invitation page, now signed in.
    await thirdPage.waitForURL(`**/invitations/**`);
    await thirdPage.getByRole('button', { name: 'Accept invitation' }).click();
    await thirdPage.waitForURL('**/');

    // --- Step C: land in org A, at the role that was actually granted —
    // checked two ways: (1) org A is reachable and org B is not (this
    // person was never invited to B), (2) the role-appropriate UI renders
    // — `assessor` has `project:create`, so "Start New Assessment" is
    // visible, tying this back to the same O-13 control this suite checks
    // elsewhere and proving the GRANTED role, not just membership.
    await expect(thirdPage.locator('h1')).toHaveText('Choose an organization');
    const orgALink = thirdPage.locator(`a[href="/orgs/${orgA.slug}/dashboard"]`);
    await expect(orgALink).toBeVisible();
    const orgBLink = thirdPage.locator(`a[href="/orgs/${orgB.slug}/dashboard"]`);
    await expect(orgBLink).toHaveCount(0);

    await orgALink.click();
    await thirdPage.waitForURL(`**/orgs/${orgA.slug}/dashboard`);
    const startLink = thirdPage.getByRole('link', { name: 'Start New Assessment' });
    if (can('assessor', 'project:create')) {
      await expect(startLink).toBeVisible();
    } else {
      await expect(startLink).toHaveCount(0);
    }

    const res = await thirdPage.goto(`/orgs/${orgB.slug}/dashboard`);
    expect(res?.status()).toBe(404);

    await thirdContext.close();
  });
});
