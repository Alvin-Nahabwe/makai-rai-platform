import 'dotenv/config';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { testDb } from '../__tests__/helpers/db';
import { escapeRe } from '../__tests__/helpers/escapeRe';
import { currentAcceptances } from '../__tests__/helpers/legalStub';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';
import type { OrgRole } from '@prisma/client';
import { COPY_LINK_COPY } from '../lib/invitations/link/copy';
import { MEMBERS_COPY as C } from '../lib/org/members/copy';
import { memberRoleWords } from '../lib/org/copy';
import { closeOpenedContexts } from './helpers/contexts';

// Every context a test opened is closed after it (helpers/contexts.ts says why).
test.afterEach(closeOpenedContexts);

/**
 * S-22 Members and S-30 Organisation details (FR-MEM-01 to FR-MEM-04, UX-23, UX-27, UX-29, NFR-INT-02,
 * NFR-A11Y-02, NFR-A11Y-05; journeys J-02 and J-14). J-02 drives the real server (the invitation, its resend and
 * its revocation), and one J-14 case changes a role and removes a member for real on a disposable member that
 * `beforeAll` makes and `afterAll` deletes. The other J-14 cases and the interaction cases script what the server
 * answers with `page.route`, so no shared fixture seat changes role or leaves (the role-matrix and two-orgs specs
 * reuse them) and no email is sent. The server-side rules of J-14 are proved by
 * __tests__/integration/mem-roles.test.ts.
 */
const manifest: FixtureManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
const org = manifest.orgs[0];
const seat = (role: OrgRole, index: 0 | 1 = 0): FixtureManifestUser => {
  const found = manifest.users.find((u) => u.orgSlug === org.slug && u.role === role && u.index === index);
  if (!found) throw new Error(`members.spec: no fixture seat ${org.slug}/${role}/${index}`);
  return found;
};
const OWNER_STATE = seat('owner').storageStatePath;
const ADMIN_STATE = seat('admin').storageStatePath;
const MEMBERS = `/orgs/${org.slug}/settings/members`;
const ORGANISATION = `/orgs/${org.slug}/settings/organisation`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** "a Reviewer", "an Admin": the role words the page passes to its manager. */
const A_ROLE = (role: OrgRole) => memberRoleWords()[role].withArticle;

let VIEWER_NAME = '';
let ASSESSOR_NAME = '';
let OWNER_NAME = '';
/** A member made for this spec (invited with Show link, registered through route 31), so J-14 can change and remove one for real. */
const DISPOSABLE_NAME = `Members Spec Disposable ${Date.now()}`;
const PENDING_EMAIL = `members-spec-pending-${Date.now()}@fixture.test`;
const RESEND_EMAIL = `members-spec-resend-${Date.now()}@fixture.test`;

const INVITED = {
  invitation: {
    id: 'inv-scripted', email: 'reviewer@fixture.test', role: 'reviewer', kind: 'member', state: 'pending',
    expiresAt: '2026-11-11T09:00:00.000Z', createdAt: '2026-11-04T09:00:00.000Z', linkShown: false,
  },
  acceptUrl: null as string | null,
  emailSent: true,
};

async function ownerApi() {
  return pwRequest.newContext({ baseURL: test.info().project.use.baseURL, storageState: OWNER_STATE });
}

test.beforeAll(async () => {
  const api = await ownerApi();
  try {
    const list = (await (await api.get(`/api/v1/orgs/${org.slug}/members`)).json()) as Array<{ userId: string; user: { name: string } }>;
    const nameOf = (role: OrgRole) => list.find((m) => m.userId === seat(role).userId)?.user.name ?? '';
    VIEWER_NAME = nameOf('viewer');
    ASSESSOR_NAME = nameOf('assessor');
    OWNER_NAME = nameOf('owner');
    const disposableEmail = `members-spec-disposable-${Date.now()}@fixture.test`;
    const invited = await api.post(`/api/v1/orgs/${org.slug}/members`, {
      data: { requestId: randomUUID(), email: disposableEmail, role: 'assessor', showLink: true },
    });
    expect(invited.status(), 'the disposable member\'s invitation').toBe(201);
    const token = String(((await invited.json()) as { acceptUrl: string }).acceptUrl).split('/').pop();
    const anonymous = await pwRequest.newContext({ baseURL: test.info().project.use.baseURL });
    try {
      const registered = await anonymous.post(`/api/v1/invitations/${token}/register`, {
        data: { name: DISPOSABLE_NAME, password: 'DisposablePass123!', acceptances: currentAcceptances() },
      });
      expect(registered.status(), 'the disposable member signs up through route 31').toBe(201);
    } finally {
      await anonymous.dispose();
    }
    for (const email of [PENDING_EMAIL, RESEND_EMAIL]) {
      const made = await api.post(`/api/v1/orgs/${org.slug}/members`, {
        data: { requestId: randomUUID(), email, role: 'reviewer', showLink: false },
      });
      expect(made.status(), `the pending invitation of ${email}`).toBe(201);
    }
  } finally {
    await api.dispose();
  }
});

test.afterAll(async () => {
  // Leave organisation A as the setup made it, even after a failed run: the disposable member's membership and this
  // spec's invitations are gone before the disconnect. The user row stays (its acceptances are append-only, so
  // deleting it is refused: consent_records is append-only), deactivated and with no usable password.
  const mine = { email: { startsWith: 'members-spec-' } };
  try {
    const users = (await testDb.user.findMany({ where: { email: { startsWith: 'members-spec-disposable-' } }, select: { id: true } })).map((u) => u.id);
    await testDb.membership.deleteMany({ where: { userId: { in: users } } });
    await testDb.invitation.deleteMany({ where: mine });
    await testDb.user.updateMany({ where: { id: { in: users } }, data: { isActive: false, passwordHash: 'not-a-login' } });
    expect({
      memberships: await testDb.membership.count({ where: { userId: { in: users } } }),
      invitations: await testDb.invitation.count({ where: mine }),
      activeUsers: await testDb.user.count({ where: { email: { startsWith: 'members-spec-disposable-' }, isActive: true } }),
    }).toEqual({ memberships: 0, invitations: 0, activeUsers: 0 });
  } finally {
    await testDb.$disconnect();
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────
type Outcome = { abort: true } | { status: number; json?: unknown; delayMs?: number };
type Sent = { url: string; method: string; body: Record<string, unknown> };

/**
 * Answers the writes (not the GETs) to `glob` from `outcomes`, one each, the last repeating, and records every
 * one of them, aborted requests included. `opts.method` limits it to one method, `opts.not` skips matching URLs.
 */
async function script(page: Page, glob: string, outcomes: Outcome[], opts: { method?: string; not?: RegExp; into?: Sent[] } = {}): Promise<Sent[]> {
  const sent = opts.into ?? [];
  let next = 0;
  await page.route(glob, async (route) => {
    const req = route.request();
    if (req.method() === 'GET' || (opts.method && req.method() !== opts.method) || (opts.not && opts.not.test(req.url()))) {
      await route.fallback();
      return;
    }
    sent.push({ url: req.url(), method: req.method(), body: JSON.parse(req.postData() ?? '{}') as Record<string, unknown> });
    const outcome = outcomes[Math.min(next++, outcomes.length - 1)];
    if (!('abort' in outcome) && outcome.delayMs) await new Promise((r) => setTimeout(r, outcome.delayMs));
    if ('abort' in outcome) await route.abort('internetdisconnected');
    else if (outcome.json === undefined) await route.fulfill({ status: outcome.status });
    else await route.fulfill({ status: outcome.status, contentType: 'application/json', body: JSON.stringify(outcome.json) });
  });
  return sent;
}

const status = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text });

async function inviteVia(page: Page, email: string, role: OrgRole | null, o: { showLink: boolean }): Promise<void> {
  await page.getByRole('textbox', { name: C.invite.emailLabel }).fill(email);
  if (role !== null) await page.getByRole('combobox', { name: C.invite.roleLabel, exact: true }).selectOption(role);
  const box = page.getByRole('checkbox', { name: C.invite.showLink, exact: true });
  if (o.showLink) await box.check(); else await box.uncheck();
  await page.getByRole('button', { name: C.invite.submit, exact: true }).click();
}
async function changeRoleVia(page: Page, name: string, role: OrgRole): Promise<void> {
  await page.getByRole('combobox', { name: C.members.roleFor(name) }).selectOption(role);
  await page.getByRole('button', { name: C.members.changeRoleFor(name) }).click();
}
const resendVia = (page: Page) => page.getByRole('button', { name: C.invitations.resendTo(RESEND_EMAIL) }).click();
async function revokeVia(page: Page): Promise<void> {
  await page.getByRole('button', { name: C.invitations.cancelTo(PENDING_EMAIL) }).click();
  await page.getByRole('button', { name: C.invitations.confirmAction, exact: true }).click();
}
const changeRoleToReviewerVia = (page: Page) => changeRoleVia(page, ASSESSOR_NAME, 'reviewer');
async function removeVia(page: Page): Promise<void> {
  await page.getByRole('button', { name: C.members.removeName(VIEWER_NAME) }).click();
  await page.getByRole('button', { name: C.members.removeAction, exact: true }).click();
}
async function leaveVia(page: Page): Promise<void> {
  await page.getByRole('button', { name: C.leave.trigger }).click();
  await page.getByRole('button', { name: C.leave.action, exact: true }).click();
}
/** Presses Tab until `target` has focus (at most `max` presses). */
async function tabTo(page: Page, target: ReturnType<Page['locator']>, max = 120): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) {
      await expectFocusVisibleAndUncovered(page);
      return;
    }
  }
  throw new Error(`tabTo: no focus on the target within ${max} Tab presses`);
}

// ── J-02 and J-14 ─────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('journeys', () => {
  test.use({ storageState: OWNER_STATE });

  test('FR-MEM-01 FR-MEM-02 UX-23: an owner invites with Show link, copies it, resends and revokes (J-02)', async ({ page, browser }) => {
    const email = `members-spec-j02-${Date.now()}@fixture.test`;
    await page.goto(MEMBERS);
    await inviteVia(page, email, 'reviewer', { showLink: true });
    // The e2e server has no email key, so the send fails visibly and the link is the way to pass it on.
    await expect(status(page, COPY_LINK_COPY.emailFailed)).toBeVisible();
    const link = page.getByRole('textbox', { name: /invitation link/i });
    const first = await link.inputValue();
    expect(first).toMatch(/\/invitations\/[0-9a-f]{64}$/);
    await expect(page.getByText('The link works once and expires on')).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: email });
    await expect(row).toBeVisible();
    await expect(row).toContainText(/\d{1,2} \w{3,4} \d{4}/);                       // its expiry date

    await page.getByRole('checkbox', { name: C.invitations.showLinkFor(email) }).check();
    await page.getByRole('button', { name: C.invitations.resendTo(email) }).click();
    await expect(link).not.toHaveValue(first);
    const second = await link.inputValue();

    const stranger = await (await browser.newContext()).newPage();
    await stranger.goto(first);
    await expect(stranger.getByText('This invitation link does not work')).toBeVisible();   // M-23: the old link is refused
    await stranger.context().close();

    await page.getByRole('button', { name: C.invitations.cancelTo(email) }).click();
    await page.getByRole('button', { name: C.invitations.confirmAction, exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: email })).toHaveCount(0);
    await expect(status(page, C.cancelled(email))).toBeVisible();
    expect(second).not.toBe(first);
  });

  test('FR-MEM-03 FR-MEM-04: an owner changes a role and removes a member; the last owner is refused (J-14)', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members/*', [{ status: 204 }]);
    await changeRoleToReviewerVia(page);
    await expect(status(page, C.roleChanged(ASSESSOR_NAME, A_ROLE('reviewer')))).toBeVisible();
    await removeVia(page);
    await expect(status(page, C.removed(VIEWER_NAME))).toBeVisible();
    await expect(page.getByRole('button', { name: C.members.removeName(VIEWER_NAME) })).toHaveCount(0);
    await script(page, '**/api/v1/orgs/*/members/*', [{ status: 409, json: { error: 'Conflict', code: 'last_active_owner' } }], { method: 'PATCH' });
    await changeRoleVia(page, OWNER_NAME, 'admin');
    await expect(status(page, C.refusals.lastOwner(OWNER_NAME))).toBeVisible();
  });

  test('FR-MEM-03 FR-MEM-04: an owner changes a role and removes a member for real, through the production server (J-14)', async ({ page }) => {
    await page.goto(MEMBERS);
    await changeRoleVia(page, DISPOSABLE_NAME, 'reviewer');
    await expect(status(page, C.roleChanged(DISPOSABLE_NAME, A_ROLE('reviewer')))).toBeVisible();
    await page.reload();
    await expect(page.getByRole('combobox', { name: C.members.roleFor(DISPOSABLE_NAME) })).toHaveValue('reviewer');   // the server kept it
    await page.getByRole('button', { name: C.members.removeName(DISPOSABLE_NAME) }).click();
    await page.getByRole('button', { name: C.members.removeAction, exact: true }).click();
    await expect(status(page, C.removed(DISPOSABLE_NAME))).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: C.members.removeName(DISPOSABLE_NAME) })).toHaveCount(0);
  });

  test('NFR-A11Y-02: J-02 and J-14 complete with the keyboard alone', async ({ page }) => {
    await page.goto(MEMBERS);
    const sent = await script(page, '**/api/v1/orgs/*/members', [{ status: 201, json: { ...INVITED, acceptUrl: 'https://h/invitations/t' } }]);
    await script(page, '**/api/v1/orgs/*/members/*', [{ status: 204 }]);
    // J-02: invite by keyboard (Tab to each field, a letter picks the role, Space ticks, Enter submits).
    await tabTo(page, page.getByRole('textbox', { name: C.invite.emailLabel }));
    await page.keyboard.type('keyboard@fixture.test');
    await tabTo(page, page.getByRole('combobox', { name: C.invite.roleLabel, exact: true }));
    await page.keyboard.type('reviewer');
    await tabTo(page, page.getByRole('checkbox', { name: C.invite.showLink, exact: true }));
    await page.keyboard.press('Space');
    await tabTo(page, page.getByRole('button', { name: C.invite.submit, exact: true }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: /invitation link/i })).toHaveValue('https://h/invitations/t');
    expect(sent[0].body).toMatchObject({ email: 'keyboard@fixture.test', role: 'reviewer', showLink: true });
    // J-14: a removal by keyboard, the confirmation included.
    await page.keyboard.press('Shift+Tab');
    await page.locator('body').focus();
    await tabTo(page, page.getByRole('button', { name: C.members.removeName(VIEWER_NAME) }));
    await page.keyboard.press('Enter');
    await tabTo(page, page.getByRole('button', { name: C.members.removeAction, exact: true }));
    await page.keyboard.press('Space');
    await expect(status(page, C.removed(VIEWER_NAME))).toBeVisible();
  });

  test('NFR-A11Y-05: S-22 and S-30 have no serious axe violation in both themes at 1280 and 360 px and no loss at 320 px', async ({ page }) => {
    for (const theme of ['light', 'dark'] as const) {
      for (const width of [1280, 360]) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme });
        for (const path of [MEMBERS, ORGANISATION]) {
          await page.goto(path);
          await expectNoSeriousA11yViolations(page, `${path} ${theme} ${width}`);
        }
      }
    }
    await page.setViewportSize({ width: 320, height: 640 });
    for (const path of [MEMBERS, ORGANISATION]) {
      await page.goto(path);
      await expectNoHorizontalScroll(page);
    }
  });
});

// ── S6 of the workshop walk: the answer to Invite (and Resend) is on the screen, with focus ─────────────────────────
/**
 * The whole of `target` is inside the viewport and below the top bar's bottom edge (the bar shows below 1024 px; at 1280 it
 * is display: none and its edge is 0). Half a pixel is allowed at each edge: an element scrolled to an edge sits at a
 * fractional offset the integer scroll position cannot reach (a status line brought to the top measured -0.5).
 */
const SUBPIXEL = 0.5;
async function expectWhollyInView(page: Page, target: ReturnType<Page['locator']>, what: string): Promise<void> {
  const box = await target.boundingBox();
  expect(box, what).not.toBeNull();
  const viewport = page.viewportSize()!;
  const barBottom = await page.locator('.shell-topbar').evaluate((el) => Math.max(0, el.getBoundingClientRect().bottom));
  expect(box!.y, `${what}: its top is below the top bar`).toBeGreaterThanOrEqual(barBottom - SUBPIXEL);
  expect(box!.y + box!.height, `${what}: its bottom is inside the viewport`).toBeLessThanOrEqual(viewport.height + SUBPIXEL);
  expect(box!.x, `${what}: its left edge is inside the viewport`).toBeGreaterThanOrEqual(-SUBPIXEL);
  expect(box!.x + box!.width, `${what}: its right edge is inside the viewport`).toBeLessThanOrEqual(viewport.width + SUBPIXEL);
}

for (const size of [{ width: 375, height: 812 }, { width: 1280, height: 800 }]) {
  test.describe(`S6: after Invite the result is in view and has focus, at ${size.width} by ${size.height}`, () => {
    test.use({ storageState: OWNER_STATE, viewport: size });

    test('an invitation with its link shown: the status sentence and the whole link box are in view, and the status has focus; Resend with the link likewise', async ({ page }) => {
      const email = `members-spec-s6-${size.width}-${Date.now()}@fixture.test`;
      await page.goto(MEMBERS);
      await inviteVia(page, email, 'viewer', { showLink: true });
      // The e2e server has no email key: the answer is the email-failure sentence and the link box.
      const sentence = status(page, COPY_LINK_COPY.emailFailed);
      await expect(sentence).toBeVisible();
      const linkBox = page.locator('.card').filter({ has: page.getByRole('textbox', { name: /invitation link/i }) });
      await expect(linkBox).toHaveCount(1);
      await expect(sentence).toBeFocused();
      await expectWhollyInView(page, sentence, 'the status sentence');
      await expectWhollyInView(page, linkBox, 'the link box (field, Copy, the "works once" sentence)');

      // Resend with "show the link", from the invitations list further down the page.
      const first = await page.getByRole('textbox', { name: /invitation link/i }).inputValue();
      await page.getByRole('checkbox', { name: C.invitations.showLinkFor(email) }).check();
      await page.getByRole('button', { name: C.invitations.resendTo(email) }).click();
      await expect(page.getByRole('textbox', { name: /invitation link/i })).not.toHaveValue(first);
      await expect(sentence).toBeFocused();
      await expectWhollyInView(page, sentence, 'the status sentence after Resend');
      await expectWhollyInView(page, linkBox, 'the link box after Resend');

      // Leave the fixture organisation as it was.
      await page.getByRole('button', { name: C.invitations.cancelTo(email) }).click();
      await page.getByRole('button', { name: C.invitations.confirmAction, exact: true }).click();
      await expect(status(page, C.cancelled(email))).toBeVisible();
    });

    test('a refusal from the server: the status sentence is in view and has focus', async ({ page }) => {
      await page.goto(MEMBERS);
      await script(page, '**/api/v1/orgs/*/members', [{ status: 409, json: { error: 'Conflict', code: 'already_member' } }], { method: 'POST' });
      await inviteVia(page, 'someone@fixture.test', 'viewer', { showLink: false });
      const sentence = status(page, C.refusals.alreadyMember);
      await expect(sentence).toBeVisible();
      await expect(sentence).toBeFocused();
      await expectWhollyInView(page, sentence, 'the refusal');
    });
  });
}

// ── S-22 interactions (scripted) ──────────────────────────────────────────────────────────────────────────────────
test.describe('S-22 interactions', () => {
  test.use({ storageState: OWNER_STATE });

  test('UX-29 FR-MEM-04 FR-MEM-02: Remove and Revoke open an inline confirmation that names the object, not a dialog', async ({ page }) => {
    await page.goto(MEMBERS);
    await page.getByRole('button', { name: C.members.removeName(VIEWER_NAME) }).click();
    await expect(page.getByRole('button', { name: C.members.removeAction, exact: true })).toBeVisible();
    await expect(page.getByText(new RegExp(VIEWER_NAME)).first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: C.invitations.cancelTo(PENDING_EMAIL) }).click();
    await expect(page.getByRole('button', { name: C.invitations.confirmAction, exact: true })).toBeVisible();
  });

  test('FR-MEM-01 FR-MEM-03 FR-MEM-04 UX-23: S-22 shows the 7.4.2 outcome sentences exactly (SRS line 2390)', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members', [{ status: 201, json: { ...INVITED, emailSent: true, acceptUrl: 'https://h/invitations/t' } }]);
    await inviteVia(page, 'reviewer@fixture.test', 'reviewer', { showLink: true });
    await expect(status(page, C.sent('reviewer@fixture.test'))).toBeVisible();
    await expect(page.getByRole('button', { name: COPY_LINK_COPY.copy })).toBeEnabled();
    await script(page, '**/api/v1/orgs/*/members/*', [{ status: 204 }]);
    await changeRoleVia(page, ASSESSOR_NAME, 'reviewer');
    await expect(status(page, C.roleChanged(ASSESSOR_NAME, A_ROLE('reviewer')))).toBeVisible();
    await script(page, '**/api/v1/orgs/*/members/*', [{ status: 409, json: { error: 'Conflict', code: 'last_active_owner' } }]);   // the later route answers first
    await changeRoleVia(page, OWNER_NAME, 'admin');
    await expect(status(page, C.refusals.lastOwner(OWNER_NAME))).toBeVisible();
  });

  test('NFR-INT-02 (owner default B32): a 200 replay of an invite says the invitation was already created, a 200 replay of a resend that it was already resent, and neither shows a copy-link box', async ({ page }) => {
    const replayed = { ...INVITED, acceptUrl: null, emailSent: false };
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members', [{ status: 200, json: replayed }]);
    await inviteVia(page, 'reviewer@fixture.test', 'reviewer', { showLink: false });
    await expect(status(page, C.replayed.invite)).toBeVisible();
    await expect(status(page, C.sent(replayed.invitation.email))).toHaveCount(0);
    await expect(page.getByText(COPY_LINK_COPY.emailFailed)).toHaveCount(0);
    await expect(page.getByText(COPY_LINK_COPY.emailFailedNoLink)).toHaveCount(0);
    await expect(page.getByRole('button', { name: COPY_LINK_COPY.copy })).toHaveCount(0);
    await script(page, '**/api/v1/orgs/*/invitations/*/resend', [{ status: 200, json: replayed }]);
    await resendVia(page);
    await expect(status(page, C.replayed.resend)).toBeVisible();
    await expect(page.getByRole('button', { name: COPY_LINK_COPY.copy })).toHaveCount(0);
  });

  test("UX-27 NFR-INT-02: a retry after \"not saved\" keeps the invite's request id, and an edited invite gets a new one", async ({ page }) => {
    await page.goto(MEMBERS);
    const sent = await script(page, '**/api/v1/orgs/*/members', [{ abort: true }, { status: 201, json: INVITED }, { status: 201, json: INVITED }]);
    await inviteVia(page, 'a@fixture.test', 'reviewer', { showLink: false });   // not saved
    await expect(status(page, C.lostReply.invite)).toBeVisible();
    await inviteVia(page, 'a@fixture.test', 'reviewer', { showLink: false });   // the same form again: a retry
    await expect(status(page, C.sent(INVITED.invitation.email))).toBeVisible();
    await inviteVia(page, 'b@fixture.test', 'reviewer', { showLink: false });   // edited
    await expect.poll(() => sent.length).toBe(3);
    expect(sent.map((x) => x.method)).toEqual(['POST', 'POST', 'POST']);
    expect(sent[1].body.requestId).toBe(sent[0].body.requestId);
    expect(sent[2].body.requestId).not.toBe(sent[0].body.requestId);
    for (const x of sent) expect(x.body.requestId).toMatch(UUID_V4);
  });

  test('FR-MEM-01: the invite form refuses a malformed email and a missing role, tied to the field', async ({ page }) => {
    await page.goto(MEMBERS);
    await inviteVia(page, 'not-an-email', null, { showLink: false });
    await expect(page.getByRole('textbox', { name: C.invite.emailLabel })).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('combobox', { name: C.invite.roleLabel, exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('textbox', { name: C.invite.emailLabel })).toHaveAccessibleDescription(/\S/);
    await expect(page.getByRole('combobox', { name: C.invite.roleLabel, exact: true })).toHaveAccessibleDescription(new RegExp(escapeRe(C.invite.roleMissing)));
  });

  test('UX-23 (CR-1): a second invitation whose email failed states it, after the first link was copied', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members', [
      { status: 201, json: { ...INVITED, emailSent: true, acceptUrl: 'https://h/invitations/first' } },
      { status: 201, json: { ...INVITED, invitation: { ...INVITED.invitation, id: 'inv-second', email: 'second@fixture.test' }, emailSent: false, acceptUrl: null } },
    ]);
    await inviteVia(page, 'first@fixture.test', 'reviewer', { showLink: true });
    await page.getByRole('button', { name: COPY_LINK_COPY.copy }).click();
    await expect(status(page, new RegExp(`${escapeRe(COPY_LINK_COPY.copied)}|${escapeRe(COPY_LINK_COPY.copyFailed)}`))).toBeVisible();
    await inviteVia(page, 'second@fixture.test', 'reviewer', { showLink: false });
    await expect(status(page, COPY_LINK_COPY.emailFailedNoLink)).toBeVisible();   // no link on the screen: the sentence names the button (answer Q21)
    await expect(status(page, new RegExp(`${escapeRe(COPY_LINK_COPY.copied)}|${escapeRe(COPY_LINK_COPY.copyFailed)}`))).toHaveCount(0);
  });

  test('NFR-A11Y-02 (A11Y-2): a refused submit puts focus on the first invalid field', async ({ page }) => {
    await page.goto(MEMBERS);
    await inviteVia(page, 'not-an-email', 'reviewer', { showLink: false });
    await expect(page.getByRole('textbox', { name: C.invite.emailLabel })).toBeFocused();
    await page.getByRole('textbox', { name: C.invite.emailLabel }).fill('ok@fixture.test');
    await page.getByRole('combobox', { name: C.invite.roleLabel, exact: true }).selectOption('');
    await page.getByRole('button', { name: C.invite.submit, exact: true }).click();
    await expect(page.getByRole('combobox', { name: C.invite.roleLabel, exact: true })).toBeFocused();
  });

  test('NFR-A11Y-02 (A11Y-3): focus is not lost after a removal, a revocation or a cancel', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members/*', [{ status: 204 }]);
    await script(page, '**/api/v1/orgs/*/invitations/*/revoke', [{ status: 204 }]);
    const open = page.getByRole('button', { name: C.members.removeName(VIEWER_NAME) });
    await open.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(open).toBeFocused();                                              // cancel returns to the opener
    await removeVia(page);
    await expect(status(page, C.removed(VIEWER_NAME))).toBeFocused();              // the row is gone: the result takes focus
    await revokeVia(page);
    await expect(status(page, C.cancelled(PENDING_EMAIL))).toBeFocused();
    await page.getByRole('button', { name: C.leave.trigger }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: C.leave.trigger })).toBeFocused();
  });

  test('NFR-A11Y-02 (ruling X-4): each confirmation opens on its first button, and cancelling it gives focus back to the control that opened it', async ({ page }) => {
    await page.goto(MEMBERS);
    const cases = [
      { trigger: page.getByRole('button', { name: C.members.removeName(VIEWER_NAME) }), group: page.getByRole('group', { name: VIEWER_NAME }), first: 'Cancel' },
      { trigger: page.getByRole('button', { name: C.invitations.cancelTo(PENDING_EMAIL) }), group: page.getByRole('group', { name: C.invitations.confirmObject(PENDING_EMAIL) }), first: C.invitations.keep },
      { trigger: page.getByRole('button', { name: C.leave.trigger }), group: page.getByRole('group', { name: OWNER_NAME }), first: 'Cancel' },
    ];
    for (const c of cases) {
      await c.trigger.focus();
      await page.keyboard.press('Enter');
      await expect(c.group.getByRole('button', { name: c.first, exact: true }), `${c.first} has focus when the confirmation opens`).toBeFocused();
      await page.keyboard.press('Enter');                                          // the first button cancels, by keyboard
      await expect(c.group).toHaveCount(0);
      await expect(c.trigger, 'focus is back on the control that opened it').toBeFocused();
    }
  });

  test('NFR-A11Y-02 (R-2): a refused removal or leave puts focus on the result, and the confirmation does not disable the pressed button', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members/*', [{ status: 409, json: { error: 'Conflict', code: 'last_active_owner' } }], { method: 'DELETE' });
    await script(page, '**/api/v1/orgs/*/members/leave', [{ status: 409, json: { error: 'Conflict', code: 'last_active_owner' } }]);
    await removeVia(page);
    await expect(status(page, C.refusals.lastOwner(VIEWER_NAME))).toBeFocused();
    await leaveVia(page);
    await expect(status(page, C.refusals.lastOwnerLeaving)).toBeFocused();
  });

  test('NFR-A11Y-02 (R-4): while a write runs, Remove, Revoke and Leave open nothing', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/invitations/*/resend', [{ status: 201, json: INVITED, delayMs: 1500 }]);
    await resendVia(page);
    await page.getByRole('button', { name: C.members.removeName(VIEWER_NAME) }).click({ force: true });
    await page.getByRole('button', { name: C.invitations.cancelTo(PENDING_EMAIL) }).click({ force: true });
    await page.getByRole('button', { name: C.leave.trigger }).click({ force: true });
    await expect(page.getByRole('button', { name: C.members.removeAction, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: C.invitations.confirmAction, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: C.leave.action, exact: true })).toHaveCount(0);
  });

  test('SC 4.1.2 (ruling L5-25): while a row write is in flight, Invite is disabled, not live, and comes back when the write ends', async ({ page }) => {
    await page.goto(MEMBERS);
    const invite = page.getByRole('button', { name: C.invite.submit, exact: true });
    await expect(invite).toBeEnabled();                                            // hydrated
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    await page.route('**/api/v1/orgs/*/invitations/*/resend', async (route) => {
      await held;
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(INVITED) });
    });
    try {
      await resendVia(page);
      await expect(page.getByRole('button', { name: C.invitations.resendTo(RESEND_EMAIL) })).toHaveAttribute('aria-disabled', 'true');
      await expect(invite).toBeDisabled();
      await expect(invite).not.toHaveAttribute('aria-busy', 'true');            // busy belongs to the pressed control only
    } finally {
      release();
    }
    await expect(status(page, C.sent(INVITED.invitation.email))).toBeVisible();
    await expect(invite).toBeEnabled();
    await page.unrouteAll({ behavior: 'wait' });
  });

  test('SC 2.4.3 NFR-INT-02 (ruling X-4): a second Enter on the busy confirm button of Remove sends no second request, and the button keeps focus', async ({ page }) => {
    await page.goto(MEMBERS);
    const sent = await script(page, '**/api/v1/orgs/*/members/*', [{ status: 204, delayMs: 1500 }], { method: 'DELETE' });
    await page.getByRole('button', { name: C.members.removeName(VIEWER_NAME) }).click();
    const confirm = page.getByRole('button', { name: C.members.removeAction, exact: true });
    await confirm.focus();
    await page.keyboard.press('Enter');
    await expect(confirm).toHaveAttribute('aria-busy', 'true');
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(status(page, C.removed(VIEWER_NAME))).toBeVisible();
    expect(sent).toHaveLength(1);
  });

  test('UX-23 (F4): revoking the invitation whose link is on show takes the link away', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members', [{ status: 201, json: { ...INVITED, emailSent: true, acceptUrl: 'https://h/invitations/t' } }]);
    await script(page, '**/api/v1/orgs/*/invitations/*/revoke', [{ status: 204 }]);
    await inviteVia(page, 'reviewer@fixture.test', 'reviewer', { showLink: true });
    await expect(page.getByRole('textbox', { name: /invitation link/i })).toBeVisible();
    await page.getByRole('button', { name: C.invitations.cancelTo('reviewer@fixture.test') }).click();
    await page.getByRole('button', { name: C.invitations.confirmAction, exact: true }).click();
    await expect(page.getByRole('textbox', { name: /invitation link/i })).toHaveCount(0);
  });

  test('NFR-INT-02 (F11): a 200 replay of an invitation that is no longer pending does not list it as pending', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members', [{ status: 200, json: { ...INVITED, invitation: { ...INVITED.invitation, id: 'inv-gone', email: 'gone@fixture.test', state: 'revoked' }, acceptUrl: null, emailSent: false } }]);
    await inviteVia(page, 'gone@fixture.test', 'reviewer', { showLink: false });
    await expect(status(page, C.replayed.invite)).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'gone@fixture.test' })).toHaveCount(0);
  });

  test('UX-23 (F13): an invitation whose email went and whose link was not asked for shows no empty box', async ({ page }) => {
    await page.goto(MEMBERS);
    const regionsBefore = await page.getByRole('status').count();   // the shell's and the page's own
    await script(page, '**/api/v1/orgs/*/members', [{ status: 201, json: { ...INVITED, emailSent: true, acceptUrl: null } }]);
    await inviteVia(page, 'reviewer@fixture.test', 'reviewer', { showLink: false });
    await expect(status(page, C.sent('reviewer@fixture.test'))).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(regionsBefore);   // no empty card with a region of its own
  });

  test('FR-MEM-01 (F15): an invitation to a current member says so', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members', [{ status: 409, json: { error: 'Conflict', code: 'already_member' } }]);
    await inviteVia(page, 'member@fixture.test', 'reviewer', { showLink: false });
    await expect(status(page, C.refusals.alreadyMember)).toBeVisible();
  });

  test('FR-MEM-02 (F10): a control pressed on an invitation that has expired shows the not-pending sentence and no Retry', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/invitations/*/resend', [{ status: 409, json: { error: 'Conflict', code: 'invitation_not_pending' } }]);
    await resendVia(page);
    await expect(status(page, C.refusals.notPending)).toBeVisible();
    await expect(page.getByRole('button', { name: /retry/i })).toHaveCount(0);
  });

  test('UX-27 (CR-5): a server error and a signed-out session have their own sentences', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members', [
      { status: 503, json: { error: 'Service unavailable', code: 'database_unavailable' } },
      { status: 401, json: { error: 'Unauthorised', code: 'unauthenticated' } },
    ]);
    await inviteVia(page, 'a@fixture.test', 'reviewer', { showLink: false });
    await expect(status(page, C.refusals.serverProblem)).toBeVisible();
    await inviteVia(page, 'a@fixture.test', 'reviewer', { showLink: false });
    await expect(status(page, C.refusals.signedOut)).toBeVisible();
  });

  test('UX-23: Resend and show link, pressed after a failed email with no link shown, resends and shows the link', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members', [{ status: 201, json: { ...INVITED, emailSent: false, acceptUrl: null } }]);
    await inviteVia(page, 'reviewer@fixture.test', 'reviewer', { showLink: false });
    await expect(status(page, COPY_LINK_COPY.emailFailedNoLink)).toBeVisible();   // no link shown: the sentence names the button below it (answer Q21)
    const resent = await script(page, '**/api/v1/orgs/*/invitations/*/resend', [{ status: 201, json: { ...INVITED, emailSent: false, acceptUrl: 'https://h/invitations/t2' } }]);
    await page.getByRole('button', { name: COPY_LINK_COPY.resend }).click();
    await expect(page.getByRole('textbox', { name: /invitation link/i })).toHaveValue('https://h/invitations/t2');
    expect(resent).toHaveLength(1);
    expect(resent[0].body.showLink).toBe(true);
  });
});

test.describe('S-22 request ids on every row action', () => {
  test.use({ storageState: ADMIN_STATE });

  test('UX-27 NFR-INT-02: resend, revoke, role change, remove and leave each send a request id in the body, and a retry of one keeps it', async ({ page }) => {
    await page.goto(MEMBERS);
    const sent: Sent[] = [];
    const twice = (ok: Outcome): Outcome[] => [{ abort: true }, ok];                         // each action twice: not saved, then saved
    await script(page, '**/api/v1/orgs/*/invitations/*/resend', twice({ status: 201, json: INVITED }), { into: sent });
    await script(page, '**/api/v1/orgs/*/invitations/*/revoke', twice({ status: 204 }), { into: sent });
    await script(page, '**/api/v1/orgs/*/members/*', twice({ status: 204 }), { method: 'PATCH', into: sent });
    await script(page, '**/api/v1/orgs/*/members/*', twice({ status: 204 }), { method: 'DELETE', into: sent });
    await script(page, '**/api/v1/orgs/*/members/leave', twice({ status: 204 }), { into: sent });
    // Each first send is lost: the status line says so in that action's own words (defect 39, answer Q1).
    const lost: Array<[(p: Page) => Promise<void>, string]> = [
      [resendVia, C.lostReply.resend], [revokeVia, C.lostReply.cancel], [changeRoleToReviewerVia, C.lostReply.role],
      [removeVia, C.lostReply.remove(VIEWER_NAME)], [leaveVia, C.lostReply.leave],
    ];
    for (const [act, sentence] of lost) {
      const before = sent.length;
      await act(page);
      await expect.poll(() => sent.length).toBe(before + 1);
      await expect(page.locator('.members > [role="status"]'), 'the lost reply in its own words').toHaveText(sentence);
      await act(page);
      await expect.poll(() => sent.length).toBe(before + 2);
    }
    await expect.poll(() => sent.length).toBe(10);
    for (let i = 0; i < 10; i += 2) {
      expect(sent[i].body.requestId).toMatch(UUID_V4);
      expect(sent[i + 1].body.requestId).toBe(sent[i].body.requestId);
    }
    expect(new Set(sent.map((x) => x.body.requestId)).size).toBe(5);
  });
});
