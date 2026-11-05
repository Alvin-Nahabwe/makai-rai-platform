import 'dotenv/config';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import { MANIFEST_PATH, adminSeat, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { abortPendingBackgroundRequests } from './helpers/pendingLinks';
import { testDb } from '../__tests__/helpers/db';
import { buildOrg } from '../__tests__/helpers/recordFixture';

/**
 * J-01, the MAK-AI administrator's journey (units/ORG.md Task 9): create an organisation with its agreement and first
 * owner (S-24), recover the first owner (resend, revoke, issue again with the controller's request reference), and
 * see it on S-23; the administrator pages hold no record content (FR-ORG-03, NFR-SEC-04 (c)); an organisation address
 * gives the administrator the same S-31 as a non-member (UX-05); the removed creation paths answer 404 (FR-ORG-04);
 * keyboard, axe and reflow (NFR-A11Y-02, NFR-A11Y-05). The administrator is the run's one seat (adminSeat(), Task 8b).
 */

function manifest(): FixtureManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as FixtureManifest;
}
function seat(m: FixtureManifest, orgSlug: string, role: string, index: 0 | 1): FixtureManifestUser {
  const found = m.users.find((u) => u.orgSlug === orgSlug && u.role === role && u.index === index);
  if (!found) throw new Error(`admin-onboarding: no seat ${orgSlug}/${role}/${index}`);
  return found;
}

test.use({ storageState: adminSeat().storageStatePath });

/** Fills S-24's create form with W-10's fields, by label. */
async function fillCreate(page: Page, name: string, ownerEmail: string): Promise<void> {
  await page.getByLabel('Organisation name').fill(name);
  await page.getByLabel('Agreement version accepted').selectOption({ index: 1 });
  await page.getByLabel('Day', { exact: true }).fill('27');
  await page.getByLabel('Month', { exact: true }).fill('10');
  await page.getByLabel('Year', { exact: true }).fill('2026');
  await page.getByLabel('Controller legal name').fill('Makerere University');
  await page.getByLabel('Data-protection contact email').fill('dpo@fixture.test');
  await page.getByLabel("First owner's email").fill(ownerEmail);
}

test.beforeEach(async ({ context }) => {
  await abortPendingBackgroundRequests(context);
});

test('FR-ORG-01 FR-ORG-02 UX-23: the administrator creates an organisation and recovers its first owner (J-01)', async ({ page }) => {
  const name = `J01 Lab ${randomUUID().slice(0, 8)}`;
  const ownerEmail = `j01-${randomUUID().slice(0, 8)}@fixture.test`;
  await page.goto('/admin/organisations');
  await page.getByRole('link', { name: 'Create organisation' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Create an organisation' })).toBeVisible();
  await fillCreate(page, name, ownerEmail);
  await page.getByLabel(/^Show link/).check();
  await page.getByRole('button', { name: 'Create organisation and send invitation' }).click();
  // The e2e server has no mail sender, so this is UX-23's failure branch: the sentence in the status region, the link.
  await expect(page.getByRole('main').getByRole('status').first()).toHaveText('Created. The invitation email could not be sent. Send this link another way.');
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeEnabled();
  await expect(page.getByLabel('Invitation link')).toHaveValue(/\/invitations\/[0-9a-f]{64}$/);
  await expect(page.getByText(/^The link works once and expires on \d{1,2} [A-Z][a-z]{2} \d{4}\.$/)).toBeVisible();

  await page.getByRole('link', { name: 'Open the organisation' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByText(`${ownerEmail} · owner · Pending`, { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Resend invitation' }).click();
  await expect(page.getByText(/^Resent: the old link no longer works\./)).toBeVisible();
  await page.getByRole('button', { name: 'Revoke invitation' }).click();
  await page.getByRole('group').getByRole('button', { name: 'Revoke invitation' }).click();
  await expect(page.getByText(`Revoked. The invitation to ${ownerEmail} no longer works.`)).toBeVisible();

  await page.getByRole('button', { name: 'Issue a new first-owner invitation' }).click();
  await page.getByLabel("New first owner's email").fill(`second-${ownerEmail}`);
  await page.getByLabel("Reference of the controller's written request").fill('CTRL-J01');
  await page.getByRole('button', { name: 'Issue invitation' }).click();
  await expect(page.getByText(/^Issued\./)).toBeVisible();
  await page.reload();
  await expect(page.getByText(`second-${ownerEmail} · owner · Pending`, { exact: false })).toBeVisible();
  await expect(page.getByText(`${ownerEmail} · owner · Revoked`, { exact: false }).first()).toBeVisible();

  await page.goto('/admin/organisations?shown=1000');
  await expect(page.getByRole('link', { name })).toBeVisible();
});

test('UX-23 FR-ORG-02: with the email failed and no link shown, Resend and show link gives the administrator a working link', async ({ page, browser }) => {
  const name = `Nolink Lab ${randomUUID().slice(0, 8)}`;
  await page.goto('/admin/organisations/new');
  await fillCreate(page, name, `nolink-${randomUUID().slice(0, 8)}@fixture.test`);
  await page.getByRole('button', { name: 'Create organisation and send invitation' }).click();
  await expect(page.getByRole('main').getByRole('status').first()).toHaveText('Created. The invitation email could not be sent. Send this link another way.');
  await expect(page.getByLabel('Invitation link')).toHaveCount(0);
  await page.getByRole('button', { name: 'Resend and show link' }).click();
  await expect(page.getByRole('main').getByRole('status').first()).toHaveText('Resent: the old link no longer works. The invitation email could not be sent. Send this link another way.');
  const link = await page.getByLabel('Invitation link').inputValue();
  expect(link).toMatch(/\/invitations\/[0-9a-f]{64}$/);
  const outsider = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const s04 = await outsider.newPage();
  const res = await s04.goto(link);
  expect(res?.status()).toBe(200);
  await expect(s04.getByRole('heading', { level: 1 })).toHaveText(`You are invited to ${name}`);
  await outsider.close();
});

test('FR-ORG-02: a revoke straight after a resend revokes the new invitation, before the page has refreshed', async ({ page }) => {
  const name = `Stale Lab ${randomUUID().slice(0, 8)}`;
  const ownerEmail = `stale-${randomUUID().slice(0, 8)}@fixture.test`;
  await page.goto('/admin/organisations/new');
  await fillCreate(page, name, ownerEmail);
  await page.getByRole('button', { name: 'Create organisation and send invitation' }).click();
  await page.getByRole('link', { name: 'Open the organisation' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  // Hold every refresh of the page's server data, so the box acts on what it was given before the refresh lands.
  await page.route('**/admin/organisations/**', async (route) => {
    if (route.request().headers()['rsc'] !== undefined) await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });
  await page.getByRole('button', { name: 'Resend invitation' }).click();
  await expect(page.getByText(/^Resent: the old link no longer works\./)).toBeVisible();
  await page.getByRole('button', { name: 'Revoke invitation' }).click();
  await page.getByRole('group').getByRole('button', { name: 'Revoke invitation' }).click();
  await expect(page.getByText(`Revoked. The invitation to ${ownerEmail} no longer works.`)).toBeVisible();
  await page.unroute('**/admin/organisations/**');
  await page.reload();
  await expect(page.getByText(`${ownerEmail} · owner · Pending`, { exact: false })).toHaveCount(0);
});

test('FR-ORG-03 NFR-SEC-04: the administrator pages hold no record content', async ({ browser, baseURL }) => {
  const m = manifest();
  const owner = seat(m, m.orgs[0].slug, 'owner', 0);
  const projectName = `ZZ-RECORD-${randomUUID().slice(0, 8)}`;
  const api = await pwRequest.newContext({ baseURL, storageState: owner.storageStatePath, extraHTTPHeaders: { origin: String(baseURL) } });
  const created = await api.post(`/api/v1/orgs/${m.orgs[0].slug}/projects`, { data: { name: projectName, aiSystemType: 'classification' } });
  expect(created.status(), 'creating a record project').toBe(201);
  await api.dispose();
  const context = await browser.newContext({ storageState: adminSeat().storageStatePath });
  await abortPendingBackgroundRequests(context);
  const page = await context.newPage();
  for (const path of ['/admin/organisations', `/admin/organisations/${m.orgs[0].id}`, '/admin/accounts']) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    const html = await page.content();
    expect(html, path).not.toContain(projectName);
    expect(html, path).not.toMatch(/Q-(PP|IP|PO)-/);
    // Organisation names are S-23's and S-24's own content, and another spec may name one "Fixture Org FINDINGS".
    const orgNames = (await testDb.organization.findMany({ select: { name: true } })).map((o) => o.name);
    let text = await page.locator('main').innerText();
    for (const n of orgNames) text = text.split(n).join('');
    expect(text, path).not.toMatch(/\b(projects?|findings?|decisions?|seals?)\b/i);
  }
  await context.close();
});

test('UX-05 FR-ORG-03: the administrator opening an organisation address sees the same S-31 as a non-member', async ({ browser, page }) => {
  const m = manifest();
  const path = `/orgs/${m.orgs[0].slug}/dashboard`;
  const asAdmin = await page.goto(path);
  expect(asAdmin?.status()).toBe(404);
  const adminMain = await page.locator('main').innerHTML();
  const outsider = seat(m, m.orgs[1].slug, 'viewer', 0);
  const context = await browser.newContext({ storageState: outsider.storageStatePath });
  await abortPendingBackgroundRequests(context);
  const other = await context.newPage();
  const asOutsider = await other.goto(path);
  expect(asOutsider?.status()).toBe(404);
  expect(await other.locator('main').innerHTML()).toBe(adminMain);
  await expect(page.locator('main')).toContainText(/not found|no access/i);
  await context.close();
});

test('FR-ORG-04: POST /api/v1/orgs and /orgs/new answer 404', async ({ page, baseURL }) => {
  const posted = await page.request.post('/api/v1/orgs', { data: { orgName: 'X' }, headers: { origin: String(baseURL) } });
  expect(posted.status()).toBe(404);
  const res = await page.goto('/orgs/new');
  expect(res?.status()).toBe(404);
});

test('NFR-A11Y-02 NFR-A11Y-05: J-01 by keyboard; S-07 and S-23 to S-25 pass axe in both themes at 1280 and 360 px and reflow at 320 px', async ({ page, browser }) => {
  test.setTimeout(180_000);
  // J-01's create form by keyboard alone: Tab to each field, type, Space for the checkbox, Enter to submit.
  await page.goto('/admin/organisations/new');
  const name = `Keys Lab ${randomUUID().slice(0, 8)}`;
  const steps: Array<[string, string | null]> = [
    ['name', name], ['agreementVersion', null], ['day', '27'], ['month', '10'], ['year', '2026'],
    ['controllerLegalName', 'Keyboard University'], ['dpContactEmail', 'dpo-keys@fixture.test'], ['ownerEmail', `keys-${randomUUID().slice(0, 8)}@fixture.test`],
  ];
  await page.getByLabel('Organisation name').focus();
  for (const [field, value] of steps) {
    await expect(page.locator(`form [name="${field}"]`)).toBeFocused();
    await expectFocusVisibleAndUncovered(page);
    if (field === 'agreementVersion') await page.keyboard.press('ArrowDown');
    else await page.keyboard.type(value!);
    await page.keyboard.press('Tab');
    if (field === 'agreementVersion' && !(await page.locator('form [name="day"]').evaluate((el) => el === document.activeElement))) await page.keyboard.press('Tab');   // past "Read this version"
  }
  await expect(page.locator('form [name="showLink"]')).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Create organisation and send invitation' })).toBeFocused();
  await expectFocusVisibleAndUncovered(page);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main').getByRole('status').first()).toHaveText(/^Created\./);

  const m = manifest();
  const pages: Array<[string, string]> = [
    ['S-23', '/admin/organisations'], ['S-24 create', '/admin/organisations/new'], ['S-24 detail', `/admin/organisations/${m.orgs[0].id}`], ['S-25', '/admin/accounts'],
  ];
  for (const [label, path] of pages) {
    for (const width of [1280, 360]) for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      await page.goto(path);
      await expectNoSeriousA11yViolations(page, `${label}, ${colorScheme}, ${width}px`);
    }
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(path);
    await expectNoHorizontalScroll(page);
  }
  // S-07's empty state: an account in no organisation (a fixture account whose membership the test removes), signed in
  // through the form from an address of its own.
  const lone = (await buildOrg({ label: `s07-${randomUUID().slice(0, 6)}` })).members.viewer;
  await testDb.membership.deleteMany({ where: { userId: lone.userId } });
  const loneContext = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '10.44.0.1' } });
  await abortPendingBackgroundRequests(loneContext);
  const lonePage = await loneContext.newPage();
  await lonePage.goto('/login');
  await lonePage.fill('#email', lone.email);
  await lonePage.fill('#password', lone.password);
  await lonePage.locator('button[type="submit"]').click();
  await lonePage.waitForURL((url) => url.pathname === '/');
  await expect(lonePage.getByText('You are not in an organisation yet: ask its owner for an invitation.')).toBeVisible();
  for (const width of [1280, 360]) for (const colorScheme of ['light', 'dark'] as const) {
    await lonePage.setViewportSize({ width, height: 900 });
    await lonePage.emulateMedia({ colorScheme });
    await lonePage.goto('/');
    await expectNoSeriousA11yViolations(lonePage, `S-07, ${colorScheme}, ${width}px`);
  }
  await lonePage.setViewportSize({ width: 320, height: 640 });
  await lonePage.goto('/');
  await expectNoHorizontalScroll(lonePage);
  await loneContext.close();
});

test.afterAll(async () => {
  await testDb.$disconnect();
});
