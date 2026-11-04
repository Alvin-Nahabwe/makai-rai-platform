import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';
import type { OrgRole } from '@prisma/client';

/**
 * S-22 Members and S-30 Organisation details (FR-MEM-01 to FR-MEM-04, UX-23, UX-27, UX-29, NFR-INT-02,
 * NFR-A11Y-02, NFR-A11Y-05; journeys J-02 and J-14). J-02 drives the real server (the invitation, its resend and
 * its revocation); J-14 and the interaction cases script what the server answers with `page.route`, so no shared
 * fixture seat changes role or leaves (the role-matrix and two-orgs specs reuse them) and no email is sent. The
 * server-side rules of J-14 are proved by __tests__/integration/mem-roles.test.ts.
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

let VIEWER_NAME = '';
let ASSESSOR_NAME = '';
let OWNER_NAME = '';
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

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────
type Outcome = { abort: true } | { status: number; json?: unknown };
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
    if ('abort' in outcome) await route.abort('internetdisconnected');
    else if (outcome.json === undefined) await route.fulfill({ status: outcome.status });
    else await route.fulfill({ status: outcome.status, contentType: 'application/json', body: JSON.stringify(outcome.json) });
  });
  return sent;
}

const status = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text });

async function inviteVia(page: Page, email: string, role: OrgRole | null, o: { showLink: boolean }): Promise<void> {
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  if (role !== null) await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption(role);
  const box = page.getByRole('checkbox', { name: 'Show link', exact: true });
  if (o.showLink) await box.check(); else await box.uncheck();
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
}
async function changeRoleVia(page: Page, name: string, role: OrgRole): Promise<void> {
  await page.getByRole('combobox', { name: `Role for ${name}` }).selectOption(role);
  await page.getByRole('button', { name: `Change role for ${name}` }).click();
}
const resendVia = (page: Page) => page.getByRole('button', { name: `Resend invitation to ${RESEND_EMAIL}` }).click();
async function revokeVia(page: Page): Promise<void> {
  await page.getByRole('button', { name: `Revoke invitation for ${PENDING_EMAIL}` }).click();
  await page.getByRole('button', { name: 'Revoke invitation', exact: true }).click();
}
const changeRoleToReviewerVia = (page: Page) => changeRoleVia(page, ASSESSOR_NAME, 'reviewer');
async function removeVia(page: Page): Promise<void> {
  await page.getByRole('button', { name: `Remove ${VIEWER_NAME}` }).click();
  await page.getByRole('button', { name: 'Remove member', exact: true }).click();
}
async function leaveVia(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Leave this organisation' }).click();
  await page.getByRole('button', { name: 'Leave organisation', exact: true }).click();
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
    await expect(status(page, 'The invitation email could not be sent. Send this link another way.')).toBeVisible();
    const link = page.getByRole('textbox', { name: /invitation link/i });
    const first = await link.inputValue();
    expect(first).toMatch(/\/invitations\/[0-9a-f]{64}$/);
    await expect(page.getByText('The link works once and expires on')).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: email });
    await expect(row).toBeVisible();
    await expect(row).toContainText(/\d{1,2} \w{3,4} \d{4}/);                       // its expiry date

    await page.getByRole('checkbox', { name: `Show link when resending to ${email}` }).check();
    await page.getByRole('button', { name: `Resend invitation to ${email}` }).click();
    await expect(link).not.toHaveValue(first);
    const second = await link.inputValue();

    const stranger = await (await browser.newContext()).newPage();
    await stranger.goto(first);
    await expect(stranger.getByText('This invitation link does not work')).toBeVisible();   // M-23: the old link is refused
    await stranger.context().close();

    await page.getByRole('button', { name: `Revoke invitation for ${email}` }).click();
    await page.getByRole('button', { name: 'Revoke invitation', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: email })).toHaveCount(0);
    await expect(status(page, `Invitation for ${email} revoked.`)).toBeVisible();
    expect(second).not.toBe(first);
  });

  test('FR-MEM-03 FR-MEM-04: an owner changes a role and removes a member; the last owner is refused (J-14)', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members/*', [{ status: 204 }]);
    await changeRoleToReviewerVia(page);
    await expect(status(page, 'Role changed to reviewer. It applies from their next action.')).toBeVisible();
    await removeVia(page);
    await expect(status(page, `${VIEWER_NAME} was removed.`)).toBeVisible();
    await expect(page.getByRole('button', { name: `Remove ${VIEWER_NAME}` })).toHaveCount(0);
    await script(page, '**/api/v1/orgs/*/members/*', [{ status: 409, json: { error: 'Conflict', code: 'last_active_owner' } }], { method: 'PATCH' });
    await changeRoleVia(page, OWNER_NAME, 'admin');
    await expect(status(page, `${OWNER_NAME} is the last owner. Make someone else an owner first.`)).toBeVisible();
  });

  test('NFR-A11Y-02: J-02 and J-14 complete with the keyboard alone', async ({ page }) => {
    await page.goto(MEMBERS);
    const sent = await script(page, '**/api/v1/orgs/*/members', [{ status: 201, json: { ...INVITED, acceptUrl: 'https://h/invitations/t' } }]);
    await script(page, '**/api/v1/orgs/*/members/*', [{ status: 204 }]);
    // J-02: invite by keyboard (Tab to each field, a letter picks the role, Space ticks, Enter submits).
    await tabTo(page, page.getByRole('textbox', { name: 'Email' }));
    await page.keyboard.type('keyboard@fixture.test');
    await tabTo(page, page.getByRole('combobox', { name: 'Role', exact: true }));
    await page.keyboard.type('reviewer');
    await tabTo(page, page.getByRole('checkbox', { name: 'Show link', exact: true }));
    await page.keyboard.press('Space');
    await tabTo(page, page.getByRole('button', { name: 'Invite', exact: true }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: /invitation link/i })).toHaveValue('https://h/invitations/t');
    expect(sent[0].body).toMatchObject({ email: 'keyboard@fixture.test', role: 'reviewer', showLink: true });
    // J-14: a removal by keyboard, the confirmation included.
    await page.keyboard.press('Shift+Tab');
    await page.locator('body').focus();
    await tabTo(page, page.getByRole('button', { name: `Remove ${VIEWER_NAME}` }));
    await page.keyboard.press('Enter');
    await tabTo(page, page.getByRole('button', { name: 'Remove member', exact: true }));
    await page.keyboard.press('Space');
    await expect(status(page, `${VIEWER_NAME} was removed.`)).toBeVisible();
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

// ── S-22 interactions (scripted) ──────────────────────────────────────────────────────────────────────────────────
test.describe('S-22 interactions', () => {
  test.use({ storageState: OWNER_STATE });

  test('UX-29 FR-MEM-04 FR-MEM-02: Remove and Revoke open an inline confirmation that names the object, not a dialog', async ({ page }) => {
    await page.goto(MEMBERS);
    await page.getByRole('button', { name: `Remove ${VIEWER_NAME}` }).click();
    await expect(page.getByRole('button', { name: 'Remove member', exact: true })).toBeVisible();
    await expect(page.getByText(new RegExp(VIEWER_NAME)).first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: `Revoke invitation for ${PENDING_EMAIL}` }).click();
    await expect(page.getByRole('button', { name: 'Revoke invitation', exact: true })).toBeVisible();
  });

  test('FR-MEM-01 FR-MEM-03 FR-MEM-04 UX-23: S-22 shows the 7.4.2 outcome sentences exactly (SRS line 2390)', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members', [{ status: 201, json: { ...INVITED, emailSent: true, acceptUrl: 'https://h/invitations/t' } }]);
    await inviteVia(page, 'reviewer@fixture.test', 'reviewer', { showLink: true });
    await expect(status(page, 'Invitation sent to reviewer@fixture.test.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy link' })).toBeEnabled();
    await script(page, '**/api/v1/orgs/*/members/*', [{ status: 204 }]);
    await changeRoleVia(page, ASSESSOR_NAME, 'reviewer');
    await expect(status(page, 'Role changed to reviewer. It applies from their next action.')).toBeVisible();
    await script(page, '**/api/v1/orgs/*/members/*', [{ status: 409, json: { error: 'Conflict', code: 'last_active_owner' } }]);   // the later route answers first
    await changeRoleVia(page, OWNER_NAME, 'admin');
    await expect(status(page, `${OWNER_NAME} is the last owner. Make someone else an owner first.`)).toBeVisible();
  });

  test('NFR-INT-02 (owner default B32): a 200 replay of an invite or of a resend shows "This invitation was already created. If the email did not arrive, use Resend." and no copy-link box', async ({ page }) => {
    const replayed = { ...INVITED, acceptUrl: null, emailSent: false };
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members', [{ status: 200, json: replayed }]);
    await inviteVia(page, 'reviewer@fixture.test', 'reviewer', { showLink: false });
    await expect(status(page, 'This invitation was already created. If the email did not arrive, use Resend.')).toBeVisible();
    await expect(status(page, 'Invitation sent to')).toHaveCount(0);
    await expect(page.getByText('The invitation email could not be sent. Send this link another way.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy link' })).toHaveCount(0);
    await script(page, '**/api/v1/orgs/*/invitations/*/resend', [{ status: 200, json: replayed }]);
    await resendVia(page);
    await expect(status(page, 'This invitation was already created. If the email did not arrive, use Resend.')).toBeVisible();
  });

  test("UX-27 NFR-INT-02: a retry after \"not saved\" keeps the invite's request id, and an edited invite gets a new one", async ({ page }) => {
    await page.goto(MEMBERS);
    const sent = await script(page, '**/api/v1/orgs/*/members', [{ abort: true }, { status: 201, json: INVITED }, { status: 201, json: INVITED }]);
    await inviteVia(page, 'a@fixture.test', 'reviewer', { showLink: false });   // not saved
    await expect(status(page, 'Not saved: connection lost. It may have arrived. Retry is safe: it will not repeat the action.')).toBeVisible();
    await inviteVia(page, 'a@fixture.test', 'reviewer', { showLink: false });   // the same form again: a retry
    await expect(status(page, 'Invitation sent to')).toBeVisible();
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
    await expect(page.getByRole('textbox', { name: 'Email' })).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('combobox', { name: 'Role', exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('textbox', { name: 'Email' })).toHaveAccessibleDescription(/\S/);
  });

  test('UX-23 (CR-1): a second invitation whose email failed states it, after the first link was copied', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members', [
      { status: 201, json: { ...INVITED, emailSent: true, acceptUrl: 'https://h/invitations/first' } },
      { status: 201, json: { ...INVITED, invitation: { ...INVITED.invitation, id: 'inv-second', email: 'second@fixture.test' }, emailSent: false, acceptUrl: null } },
    ]);
    await inviteVia(page, 'first@fixture.test', 'reviewer', { showLink: true });
    await page.getByRole('button', { name: 'Copy link' }).click();
    await expect(status(page, /Link copied|could not be copied/)).toBeVisible();
    await inviteVia(page, 'second@fixture.test', 'reviewer', { showLink: false });
    await expect(status(page, 'The invitation email could not be sent. Send this link another way.')).toBeVisible();
    await expect(status(page, /Link copied|could not be copied/)).toHaveCount(0);
  });

  test('NFR-A11Y-02 (A11Y-2): a refused submit puts focus on the first invalid field', async ({ page }) => {
    await page.goto(MEMBERS);
    await inviteVia(page, 'not-an-email', 'reviewer', { showLink: false });
    await expect(page.getByRole('textbox', { name: 'Email' })).toBeFocused();
    await page.getByRole('textbox', { name: 'Email' }).fill('ok@fixture.test');
    await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption('');
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Role', exact: true })).toBeFocused();
  });

  test('NFR-A11Y-02 (A11Y-3): focus is not lost after a removal, a revocation or a cancel', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members/*', [{ status: 204 }]);
    await script(page, '**/api/v1/orgs/*/invitations/*/revoke', [{ status: 204 }]);
    const open = page.getByRole('button', { name: `Remove ${VIEWER_NAME}` });
    await open.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(open).toBeFocused();                                              // cancel returns to the opener
    await removeVia(page);
    await expect(status(page, `${VIEWER_NAME} was removed.`)).toBeFocused();       // the row is gone: the result takes focus
    await revokeVia(page);
    await expect(status(page, `Invitation for ${PENDING_EMAIL} revoked.`)).toBeFocused();
    await page.getByRole('button', { name: 'Leave this organisation' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Leave this organisation' })).toBeFocused();
  });

  test('UX-23: Resend and show link, pressed after a failed email with no link shown, resends and shows the link', async ({ page }) => {
    await page.goto(MEMBERS);
    await script(page, '**/api/v1/orgs/*/members', [{ status: 201, json: { ...INVITED, emailSent: false, acceptUrl: null } }]);
    await inviteVia(page, 'reviewer@fixture.test', 'reviewer', { showLink: false });
    await expect(status(page, 'The invitation email could not be sent. Send this link another way.')).toBeVisible();
    const resent = await script(page, '**/api/v1/orgs/*/invitations/*/resend', [{ status: 201, json: { ...INVITED, emailSent: false, acceptUrl: 'https://h/invitations/t2' } }]);
    await page.getByRole('button', { name: 'Resend and show link' }).click();
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
    for (const act of [resendVia, revokeVia, changeRoleToReviewerVia, removeVia, leaveVia]) {
      await act(page);
      await expect.poll(() => sent.length).toBeGreaterThan(0);
      await act(page);
    }
    await expect.poll(() => sent.length).toBe(10);
    for (let i = 0; i < 10; i += 2) {
      expect(sent[i].body.requestId).toMatch(UUID_V4);
      expect(sent[i + 1].body.requestId).toBe(sent[i].body.requestId);
    }
    expect(new Set(sent.map((x) => x.body.requestId)).size).toBe(5);
  });
});
