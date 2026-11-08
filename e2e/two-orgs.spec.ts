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
 * fixture's two orgs (`__tests__/helpers/fixture.ts`, each built by K0a's
 * `buildOrg`) share no member. That is structurally the thing this gate
 * requires: two disjoint orgs, not one org holding every role.
 * `e2e/org-routing.spec.ts` covers "a member of org A gets 404 on org B"
 * for one pair. What THIS file adds is the part that spec does not
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

    // The e2e server has no email key (playwright.config.ts's webServer.env), so the send fails locally: emailSent false
    // proves only that, and the accept link is the way to pass the invitation on. It is read from CopyLinkFallback's
    // read-only field (UX-23), shown because Show link is ticked.
    const invitePost = ownerPage.waitForResponse(
      (r) => r.url().includes('/members') && r.request().method() === 'POST',
    );
    await ownerPage.getByRole('checkbox', { name: 'Show link', exact: true }).check();
    await ownerPage.getByRole('button', { name: 'Invite' }).click();
    const body = await (await invitePost).json();
    expect(body.emailSent, 'the email leg must fail locally, not succeed remotely').toBe(false);

    // The link sits in a read-only text field (CopyLinkFallback, UX-23), not in an anchor.
    const acceptLink = ownerPage.getByRole('textbox', { name: /invitation link/i });
    await expect(acceptLink).toBeVisible();
    const acceptUrl = await acceptLink.inputValue();
    expect(acceptUrl).toBeTruthy();
    await ownerContext.close();

    // --- Step B: an entirely anonymous browser context (no storageState —
    // this person has never touched the app before) follows the one-time
    // link and creates the account on S-04: name and password, then the
    // three acceptances, then Create account, which signs the person in and
    // lands on org A's dashboard with the welcome (FR-ACC-01, FR-ACC-03).
    const thirdContext = await browser.newContext();
    const thirdPage = await thirdContext.newPage();

    await thirdPage.goto(acceptUrl!);
    await expect(thirdPage.locator('h1')).toHaveText(/^You are invited to \S/);
    await expect(thirdPage.getByLabel(/^Email/)).toHaveValue(thirdEmail);
    await expect(thirdPage.locator('body')).toContainText('invited you as an assessor');

    await thirdPage.getByLabel('Your name').fill('Two Orgs Third Person');
    await thirdPage.getByLabel('Password', { exact: true }).fill(thirdPassword);
    await thirdPage.getByRole('button', { name: 'Continue' }).click();
    for (const box of await thirdPage.getByRole('checkbox').all()) await box.check();
    await thirdPage.getByRole('button', { name: 'Create account' }).click();

    // --- Step C: land in org A, at the role that was actually granted —
    // checked two ways: (1) org A is reachable and org B is not (this
    // person was never invited to B), (2) the role-appropriate UI renders
    // — `assessor` has `project:create`, so "New project" is
    // visible, tying this back to the same O-13 control this suite checks
    // elsewhere and proving the GRANTED role, not just membership.
    await thirdPage.waitForURL(`**/orgs/${orgA.slug}/dashboard?welcome=1`);
    const startLink = thirdPage.getByRole('link', { name: 'New project' });
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
