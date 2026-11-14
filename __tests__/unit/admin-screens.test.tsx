import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Identity } from '@/lib/auth/identity';
import type { AdminOrganisationRow } from '@/types/api';
import type { AdminAccountRow } from '@/lib/data/admin';
import type { InvitationState } from '@/types/record';
import { COPY_LINK_COPY } from '@/lib/invitations/link/copy';
import { ORG_COPY } from '@/lib/org/copy';
import { ADMIN_COPY } from '@/lib/admin/copy';
import { ADMIN_FORMS_COPY } from '@/lib/admin/forms/copy';

/**
 * The administrator's screens S-23 (`/admin/organisations`) and S-25 (`/admin/accounts`), the landing page
 * S-07 (`/`) and the administrator's sidebar links (FR-ORG-03, FR-ORG-06, FR-ORG-07, UX-01, UX-43; SRS
 * lines 571, 1514, 1540, 2387). vitest runs in the `node` environment without a DOM library (an install is
 * a download), so the pages are rendered to markup with react-dom/server and their data reads are mocked;
 * the e2e of Task 9 drives them in a browser.
 */

const requireIdentityMock = vi.hoisted(() => vi.fn());
const listOrganisationsMock = vi.hoisted(() => vi.fn());
const accountsMock = vi.hoisted(() => vi.fn());
const organisationMock = vi.hoisted(() => vi.fn());
const findUniqueMock = vi.hoisted(() => vi.fn());
const membershipsMock = vi.hoisted(() => vi.fn());
const readSessionDeadlines = vi.hoisted(() => vi.fn());
const pathnameMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/identity', () => ({ requireIdentity: requireIdentityMock }));
vi.mock('@/lib/data/admin', () => ({ listOrganisationsForAdmin: listOrganisationsMock, accountsForAdmin: accountsMock, organisationForAdmin: organisationMock }));
vi.mock('@/lib/data/identity', () => ({ identityDb: { user: { findUnique: findUniqueMock } } }));
vi.mock('@/lib/data/preauth', () => ({ membershipsForUser: membershipsMock }));
vi.mock('@/lib/auth/idleDeadline', () => ({ readSessionDeadlines }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), usePathname: () => pathnameMock(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

const { default: LandingPage } = await import('@/app/page');
const { default: OrganisationsPage } = await import('@/app/(authenticated)/admin/organisations/page');
const { default: AccountsPage } = await import('@/app/(authenticated)/admin/accounts/page');
const { default: Rail } = await import('@/components/layout/Rail');
const { default: NewOrganisationPage } = await import('@/app/(authenticated)/admin/organisations/new/page');
const { default: OrganisationPage } = await import('@/app/(authenticated)/admin/organisations/[id]/page');
const { CreateOrganisationFormView, createErrors, createFields, createResult, resentResult, EMAIL_FAILED, ALREADY_RESENT, ALREADY_CREATED } = await import('@/components/admin/CreateOrganisationForm');
const { MAX_LEGAL_NAME, MAX_ORG_NAME } = await import('@/lib/admin/limits');
const { OwnerInvitationBox, resendWords } = await import('@/components/admin/OwnerInvitationBox');
const { correctNameError } = await import('@/components/admin/CorrectNameForm');
const { CorrectLegalNameView, correctLegalName, correctLegalNameError, cancelledForm, UNCHANGED_LEGAL_NAME } = await import('@/components/admin/CorrectLegalNameForm');
const { AgreementRecords } = await import('@/components/admin/AgreementRecords');
const { NotFoundError } = await import('@/lib/data/tenant');

const identity = (platformRole: 'admin' | 'assessor', userId = `${platformRole}-1`): Identity =>
  ({ userId, email: `${userId}@fixture.test`, name: userId, platformRole, mustChangePassword: false }) as Identity;
const adminIdentity = identity('admin');
const assessorIdentity = identity('assessor');
const noOrgIdentity = identity('assessor', 'no-org-1');

const row = (over: Partial<AdminOrganisationRow> = {}): AdminOrganisationRow => ({
  orgId: 'org-1', name: 'Makerere CAI Lab', createdAt: '2026-10-30T09:00:00.000Z', legalName: 'Makerere University',
  memberCount: 5, ownerInvitationState: 'accepted', hasActiveOwner: true, archived: false, ...over,
});
const acct = (over: Partial<AdminAccountRow> = {}): AdminAccountRow => ({
  userId: 'u-2', name: 'Grace Nakato', email: 'grace@fixture.test', platformRole: 'assessor', isActive: true,
  createdAt: '2026-10-30T09:00:00.000Z', onlyActiveOwnerOf: [], ...over,
});

async function renderLanding(who: Identity): Promise<string> {
  requireIdentityMock.mockResolvedValue(who);
  return renderToStaticMarkup(await LandingPage());
}
async function renderS23Page(who: Identity, searchParams: Record<string, string> = {}): Promise<string> {
  requireIdentityMock.mockResolvedValue(who);
  return renderToStaticMarkup(await OrganisationsPage({ searchParams: Promise.resolve(searchParams) }));
}
async function renderS23(rows: AdminOrganisationRow[], searchParams: Record<string, string> = {}): Promise<string> {
  listOrganisationsMock.mockResolvedValue(rows);
  return renderS23Page(adminIdentity, searchParams);
}
async function renderS25Page(who: Identity, searchParams: Record<string, string> = {}): Promise<string> {
  requireIdentityMock.mockResolvedValue(who);
  return renderToStaticMarkup(await AccountsPage({ searchParams: Promise.resolve(searchParams) }));
}
async function renderS25(accounts: AdminAccountRow[], searchParams: Record<string, string> = {}): Promise<string> {
  accountsMock.mockResolvedValue(accounts);
  return renderS25Page(adminIdentity, searchParams);
}

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueMock.mockResolvedValue({ lastActiveOrgId: null });
  membershipsMock.mockResolvedValue([]);
  readSessionDeadlines.mockResolvedValue(null);
  listOrganisationsMock.mockResolvedValue([row()]);
  accountsMock.mockResolvedValue([acct({ userId: adminIdentity.userId, name: 'Ada Admin', platformRole: 'admin' }), acct()]);
});

describe('S-07, the landing page', () => {
  it('UX-01 FR-ORG-03: the administrator lands on S-23; an account with no organisation sees the S-07 empty state', async () => {
    await expect(renderLanding(adminIdentity)).rejects.toMatchObject({ digest: expect.stringMatching(/NEXT_REDIRECT;.*\/admin\/organisations/) });
    expect(membershipsMock).not.toHaveBeenCalled();   // gate 4 comes before the membership dispatch
    const html = await renderLanding(noOrgIdentity);
    expect(html).toContain(ORG_COPY.chooser.emptyBody.replace("'", '&#x27;'));
    expect(html).not.toMatch(/Create (a new|an) organi[sz]ation/);
    expect(html).not.toContain('/orgs/new');
  });

  it('UX-43: S-07 renders the idle warning from the session deadlines when it renders, and none when they cannot be read', async () => {
    readSessionDeadlines.mockResolvedValue({ secondsLeft: 3000, absoluteSecondsLeft: 500000 });
    const html = await renderLanding(noOrgIdentity);
    expect(html).toContain('data-seconds-left="3000"');
    membershipsMock.mockResolvedValue([
      { orgId: 'o1', role: 'owner', org: { id: 'o1', slug: 'a-lab', name: 'A Lab' } },
      { orgId: 'o2', role: 'viewer', org: { id: 'o2', slug: 'b-lab', name: 'B Lab' } },
    ]);
    expect(await renderLanding(noOrgIdentity)).toContain('data-seconds-left="3000"');   // the organisation picker too
    membershipsMock.mockResolvedValue([]);
    readSessionDeadlines.mockResolvedValue(null);
    expect(await renderLanding(noOrgIdentity)).not.toContain('data-seconds-left');
    readSessionDeadlines.mockClear();
    await expect(renderLanding(adminIdentity)).rejects.toMatchObject({ digest: expect.stringMatching(/NEXT_REDIRECT/) });
    expect(readSessionDeadlines).not.toHaveBeenCalled();   // the administrator is redirected before any render
  });
});

describe('S-23, organisations', () => {
  it('FR-ORG-06 FR-ORG-07: S-23 flags a missing legal name and a missing active owner, in words', async () => {
    const html = await renderS23([row({ orgId: 'o-a', name: 'No Legal Name Lab', legalName: null }), row({ orgId: 'o-b', name: 'No Owner Lab', hasActiveOwner: false, ownerInvitationState: 'expired' })]);
    expect(html).toContain('<strong>Legal name not recorded</strong>');
    expect(html).toMatch(/<td[^>]*><span[^>]*>Legal name<\/span>Makerere University<\/td>/);   // the other row's value, in its cell
    expect(html).not.toContain('Current agreement');
    expect(html).toContain(ADMIN_COPY.organisations.noActiveOwner);
    expect(html).toContain('Expired');
    expect(html).toContain('<caption');
    for (const col of Object.values(ADMIN_COPY.organisations.columns))
      expect(html).toMatch(new RegExp(`<th[^>]*scope="col"[^>]*>${col}</th>`));
    expect(html).toContain('href="/admin/organisations/o-a"');
    expect(html).toContain('30 Oct 2026');
  });

  it('FR-ORG-03: S-23 shows the 7.4.2 empty state and a non-administrator gets only the refusal line (SRS line 2387)', async () => {
    const empty = await renderS23([]);
    expect(empty).toContain('<p>No organisations yet.</p>');
    expect(empty).not.toContain('agreement');
    expect(empty).toMatch(/<a [^>]*href="\/admin\/organisations\/new"[^>]*>Create organisation<\/a>/);
    expect(empty).not.toContain('<table');
    for (const page of [renderS23Page, renderS25Page]) {
      listOrganisationsMock.mockClear(); accountsMock.mockClear();
      const html = await page(assessorIdentity);
      expect(html).toContain(ADMIN_COPY.refusal.line);
      expect(html).not.toContain('<table');
      expect(listOrganisationsMock).not.toHaveBeenCalled();
      expect(accountsMock).not.toHaveBeenCalled();
    }
  });
});

describe('S-25, accounts', () => {
  it('FR-ORG-07: S-25 warns before deactivating an only active owner, naming the organisation', async () => {
    const html = await renderS25([acct({ onlyActiveOwnerOf: ['Makerere CAI Lab'] })]);
    expect(html).toContain(ADMIN_COPY.accounts.onlyOwner('Grace Nakato', 'Makerere CAI Lab').replaceAll("'", '&#x27;'));
    const field = /<input[^>]*name="requestReference"[^>]*>/.exec(html)?.[0] ?? '';
    expect(field).toMatch(/\brequired\b/);
    expect(field).toMatch(/maxlength="200"/i);
    expect(field).toMatch(/aria-describedby="only-owner-u-2"/);
    const plain = await renderS25([acct()]);
    expect(plain).not.toContain('admin-account__warning');   // no warning of any words on a row that needs none
    expect(plain).not.toMatch(/only active Owner of/);
    expect(plain).not.toContain('name="requestReference"');
  });

  it('FR-ORG-07 NFR-SEC-19: S-25 lives at /admin/accounts and shows one banner per refusal code', async () => {
    expect(existsSync('app/(authenticated)/admin/accounts/page.tsx')).toBe(true);
    expect(existsSync('app/(authenticated)/admin/users/page.tsx')).toBe(false);
    expect(existsSync('app/(authenticated)/admin/settings/page.tsx')).toBe(false);
    const banners = new Map<string, string>();
    for (const code of ['self', 'request_reference_required', 'has_membership', 'single_admin']) {
      const html = await renderS25([acct()], { error: code });
      expect(html, code).toMatch(/<div role="alert" id="accounts-refusal"/);   // the banner itself: the kit table has a status line of its own
      banners.set(code, html);
    }
    expect(banners.get('self')).toContain(ADMIN_COPY.accounts.refusals.self);
    expect(banners.get('request_reference_required')).toContain(ADMIN_COPY.accounts.refusals.request_reference_required);
    expect(banners.get('has_membership')).toContain(ADMIN_COPY.accounts.refusals.has_membership);
    expect(banners.get('single_admin')).toContain(ADMIN_COPY.accounts.refusals.single_admin);
    expect(await renderS25([acct()], { error: 'something-else' })).not.toMatch(/role="alert"/);
    expect(await renderS25([acct()])).not.toMatch(/role="alert"/);
  });

  it('FR-ORG-07 NFR-SEC-19: S-25 offers deactivation for others, nothing for the administrator, and no platform-role grant', async () => {
    const html = await renderS25([acct({ userId: adminIdentity.userId, name: 'Ada Admin', platformRole: 'admin' }), acct(), acct({ userId: 'u-3', name: 'Inactive Ivan', isActive: false })]);
    expect(html).toContain('action="/api/admin/users/u-2/role"');
    expect(html).not.toContain(`action="/api/admin/users/${adminIdentity.userId}/role"`);
    expect(html).toMatch(/<button[^>]*aria-label="Deactivate Grace Nakato"[^>]*>Deactivate<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-label="Reactivate Inactive Ivan"[^>]*>Reactivate<\/button>/);
    // Each button posts the state it names, never a toggle, with a request id (controller ruling on route 47).
    const formOf = (userId: string) => new RegExp(`<form action="/api/admin/users/${userId}/role"[\\s\\S]*?</form>`).exec(html)?.[0] ?? '';
    expect(formOf('u-2')).toContain('name="active" value="false"');
    expect(formOf('u-3')).toContain('name="active" value="true"');
    for (const f of [formOf('u-2'), formOf('u-3')]) expect(f).toMatch(/name="requestId" value="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/);
    expect(html).not.toContain('name="action"');
    expect(html).not.toMatch(/name="role" value="admin"/);
    expect(html).not.toMatch(/Promote/);
    expect(html).toContain('Deactivated');
    expect(html).toContain('MAK-AI administrator');
  });
});

describe('S-25 and S-24 words no other case pins (copy review 7, answer Q6)', () => {
  it('FR-ORG-07 (AD10, answer Q6): an account that is not the administrator reads "Team member", and no row reads "Assessor"', async () => {
    const html = await renderS25([acct({ userId: adminIdentity.userId, name: 'Ada Admin', platformRole: 'admin' }), acct()]);
    const typeCells = [...html.matchAll(/<td[^>]*><span[^>]*>Account type<\/span>([^<]*)<\/td>/g)].map((m) => m[1]);
    expect(typeCells).toEqual(['MAK-AI administrator', 'Team member']);
    expect(html).not.toMatch(/\bAssessor\b/);
  });

  it('FR-ORG-02 (AD96, answer Q6): an owner invitation line gives the link\'s expiry for a pending invitation only', () => {
    const base = { id: 'inv-q6', email: 'q6@fixture.test', role: 'owner' as const, kind: 'first_owner' as const,
      expiresAt: '2026-11-03T09:00:00.000Z', createdAt: '2026-10-27T09:00:00.000Z', linkShown: false };
    const lineOf = (state: InvitationState) => {
      const html = renderToStaticMarkup(<OwnerInvitationBox orgId="org-1" hasActiveOwner={state === 'accepted'} invitations={[{ ...base, state }]} />);
      return /<li>([\s\S]*?)<\/li>/.exec(html)?.[1].replace(/<[^>]*>/g, '') ?? '';
    };
    expect(lineOf('pending')).toBe('q6@fixture.test · Pending · link expires 3 Nov 2026');
    for (const state of ['accepted', 'expired', 'revoked'] as const) {
      expect(lineOf(state), state).not.toContain('link expires');
      expect(lineOf(state), state).toMatch(/^q6@fixture\.test · (Accepted|Expired|Cancelled)$/);
    }
  });
});

describe('S-23 and S-25 in pages of 50 (UX-40)', () => {
  it('UX-40 FR-ORG-07: S-25 shows 50 accounts and a Show more link, and the next page shows the rest', async () => {
    const many = Array.from({ length: 51 }, (_, i) => acct({ userId: `u-${i}`, name: `Person ${i}` }));
    const first = await renderS25(many);
    expect(first).toContain('Person 49');
    expect(first).not.toContain('Person 50');
    expect(first).toMatch(/<a [^>]*href="\?shown=100"[^>]*>Show more<\/a>/);
    const all = await renderS25(many, { shown: '100' });
    expect(all).toContain('Person 50');
    expect(all).not.toContain('Show more');
  });

  it('UX-40 FR-ORG-03: S-23 shows 50 organisations and a Show more link', async () => {
    const many = Array.from({ length: 51 }, (_, i) => row({ orgId: `o-${i}`, name: `Lab ${String(i).padStart(2, '0')}` }));
    const first = await renderS23(many);
    expect(first).toContain('Lab 49');
    expect(first).not.toContain('Lab 50');
    expect(first).toMatch(/<a [^>]*href="\?shown=100"[^>]*>Show more<\/a>/);
  });
});

describe('the administrator sidebar', () => {
  it('UX-01: the administrator sidebar links S-23 and S-25 (SRS line 1514)', () => {
    pathnameMock.mockReturnValue('/admin/organisations');
    const html = renderToStaticMarkup(<Rail shell={{ userName: 'A', userId: 'a-1', roleLabels: {}, platformLabel: 'MAK-AI administrator', orgs: [], homeSlug: null }} />);
    expect(html).toMatch(/<a [^>]*href="\/admin\/organisations"[^>]*>(?:<svg[\s\S]*?<\/svg>)?<span>Organisations<\/span><\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/admin\/accounts"[^>]*>(?:<svg[\s\S]*?<\/svg>)?<span>Accounts<\/span><\/a>/);
    expect(html).not.toMatch(/>Settings<\/(?:span|a)>/);
    expect(html).not.toContain('/admin/users');
  });
});

// ── S-24 (Task 8) ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('S-24, creating and recovering an organisation', () => {
  const blank = { name: '', legalName: '', ownerEmail: '', showLink: false };
  const filled = { name: 'Makerere CAI Lab', legalName: 'Makerere University', ownerEmail: 'head@fixture.test', showLink: true };
  const CREATED = {
    orgId: 'org-9', slug: 'makerere-cai-lab', acceptUrl: 'https://h/invitations/t', emailSent: false,
    invitation: { id: 'inv-9', email: 'head@fixture.test', role: 'owner' as const, kind: 'first_owner' as const, state: 'pending' as InvitationState,
      expiresAt: '2026-11-03T09:00:00.000Z', createdAt: '2026-10-27T09:00:00.000Z', linkShown: true },
  };
  const view = (over: Partial<Parameters<typeof CreateOrganisationFormView>[0]> = {}) => renderToStaticMarkup(
    <CreateOrganisationFormView draft={filled} errors={{}} status="" busy={false} result={null}
      onChange={vi.fn()} onSubmit={vi.fn()} onRetry={vi.fn()} {...over} />);
  /** The text inside the page's status region, which must exist before any result is put in it. */
  const statusText = (html: string) => /<div role="status"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1];

  it('UX-23 FR-ORG-02: after creation S-24 shows the copy link and the expiry, and the email failure sentence in the region that was there before', () => {
    expect(statusText(view())).toBe('');   // mounted, empty, before the send
    const result = createResult({ kind: 'saved', status: 201, body: CREATED });
    const html = view({ result, status: result.status });
    expect(statusText(html)).toBe(`Created. ${EMAIL_FAILED}`);
    expect(html.split(EMAIL_FAILED)).toHaveLength(2);   // once, in the status region: the link box does not print it again
    expect(html).toMatch(new RegExp(`<button[^>]*>${COPY_LINK_COPY.copy}</button>`));
    expect(html).toContain('https://h/invitations/t');
    expect(html).toContain('The link works once and expires on 3 Nov 2026.');
    expect(html).not.toContain('<form');
  });

  it('UX-23 NFR-INT-02 (C4 CR-1): a replayed resend (200) says it was already resent, not that the email failed, and opens no link box', () => {
    expect(ALREADY_RESENT).toBe(ADMIN_FORMS_COPY.invitation.alreadyResent);
    const inv = { ...CREATED.invitation, id: 'inv-11' };
    expect(resendWords({ kind: 'saved', status: 200, body: { invitation: inv, acceptUrl: null, emailSent: false } })).toBe(ALREADY_RESENT);
    expect(resendWords({ kind: 'saved', status: 201, body: { invitation: inv, acceptUrl: null, emailSent: false } })).toBe(`Resent: the old link no longer works. ${COPY_LINK_COPY.emailFailedNoLink}`);
    expect(resendWords({ kind: 'saved', status: 201, body: { invitation: inv, acceptUrl: null, emailSent: true } })).toBe(`Resent: the old link no longer works. Invitation sent to ${inv.email}.`);
    const created = createResult({ kind: 'saved', status: 201, body: { ...CREATED, acceptUrl: null } });
    if (created.kind !== 'created') throw new Error('expected created');
    const replay = resentResult(created.response, { kind: 'saved', status: 200, body: { invitation: inv, acceptUrl: null, emailSent: false } });
    expect(replay.status).toBe(ALREADY_RESENT);
    const html = view({ result: replay, status: replay.status, onResendWithLink: vi.fn() });
    expect(html).not.toContain(COPY_LINK_COPY.resend);
    expect(html).not.toContain(COPY_LINK_COPY.linkLabel);
    expect(html.split(EMAIL_FAILED)).toHaveLength(1);
  });

  it('UX-23 NFR-INT-02: a replayed create (200) says the organisation was already created, not that the email failed, and opens no link box', () => {
    expect(ALREADY_CREATED).toBe(ADMIN_FORMS_COPY.create.alreadyCreated);
    const replay = createResult({ kind: 'saved', status: 200, body: { ...CREATED, acceptUrl: null, emailSent: false } });
    expect(replay.status).toBe(ALREADY_CREATED);
    const html = view({ result: replay, status: replay.status, onResendWithLink: vi.fn() });
    expect(statusText(html)).toBe(ALREADY_CREATED);
    expect(html).not.toContain(COPY_LINK_COPY.resend);
    expect(html).not.toContain(COPY_LINK_COPY.linkLabel);
    expect(html).toContain('Open the organisation');
  });

  it('FR-ORG-10 (C4 ORG-SF-4): the name correction refuses the name the organisation already has', () => {
    expect(correctNameError('Makerere CAI Lab', 'Makerere CAI Lab')).toBe("This is already the organisation's name.");
    expect(correctNameError('  Makerere CAI Lab ', 'Makerere CAI Lab')).toBe("This is already the organisation's name.");
    expect(correctNameError('', 'Makerere CAI Lab')).toBe(ADMIN_FORMS_COPY.name.missing);
    expect(correctNameError('x'.repeat(101), 'Makerere CAI Lab')).toBe('Use 100 characters or fewer.');
    expect(correctNameError('Makerere CAI Laboratory', 'Makerere CAI Lab')).toBeUndefined();
  });

  it('FR-ORG-02 FR-ORG-04 (C4 ORG-SF-5): for an archived organisation S-24 offers no Issue, Resend or Revoke and says it is archived', () => {
    const inv = { ...CREATED.invitation, id: 'inv-12' };
    const live = renderToStaticMarkup(<OwnerInvitationBox orgId="org-1" hasActiveOwner={false} invitations={[inv]} archived={false} />);
    expect(live).toContain(ADMIN_FORMS_COPY.invitation.resend);
    for (const invitations of [[inv], []]) {
      const html = renderToStaticMarkup(<OwnerInvitationBox orgId="org-1" hasActiveOwner={false} invitations={invitations} archived />);
      expect(html).toContain(ADMIN_FORMS_COPY.invitation.archived);
      for (const action of [ADMIN_FORMS_COPY.invitation.resend, ADMIN_FORMS_COPY.invitation.cancelTrigger, ADMIN_FORMS_COPY.invitation.sendNew]) expect(html).not.toContain(action);
    }
  });

  it('UX-23 FR-ORG-02: when the email failed and no link was shown, S-24 offers Resend and show link, and the resend shows the new link', () => {
    const noLink = createResult({ kind: 'saved', status: 201, body: { ...CREATED, acceptUrl: null, invitation: { ...CREATED.invitation, linkShown: false } } });
    const html = view({ result: noLink, status: noLink.status, onResendWithLink: vi.fn() });
    expect(statusText(html)).toBe(`Created. ${COPY_LINK_COPY.emailFailedNoLink}`);
    expect(html).toMatch(new RegExp(`<button[^>]*>${COPY_LINK_COPY.resend}</button>`));
    expect(html).not.toContain(COPY_LINK_COPY.linkLabel);
    if (noLink.kind !== 'created') throw new Error('expected created');
    const resentInv = { ...CREATED.invitation, id: 'inv-10', linkShown: true };
    const resent = resentResult(noLink.response, { kind: 'saved', status: 201, body: { invitation: resentInv, acceptUrl: 'https://h/invitations/u', emailSent: false } });
    expect(resent.status).toBe(`Resent: the old link no longer works. ${EMAIL_FAILED}`);
    if (resent.kind !== 'created') throw new Error('expected created');
    expect(resent.response).toMatchObject({ orgId: 'org-9', slug: 'makerere-cai-lab', acceptUrl: 'https://h/invitations/u', invitation: { id: 'inv-10' } });
    const after = view({ result: resent, status: resent.status, onResendWithLink: vi.fn() });
    expect(after).toContain('https://h/invitations/u');
    expect(after).not.toContain(COPY_LINK_COPY.resend);
    const refused = resentResult(noLink.response, { kind: 'rejected', status: 409, body: { error: 'x', code: 'invitation_not_pending' } });
    expect(refused.kind).toBe('created');   // the organisation stays created; only the resend was refused
    expect(refused.status).toBe(ADMIN_FORMS_COPY.create.resendRefusals.notPending);
  });

  it('UX-23 (answer Q21): on the create screen the email-failed sentence names the link when the link is shown, and the button when it is not', () => {
    const NO_LINK = 'The invitation email could not be sent. Select Send the email again and show the link.';
    expect(COPY_LINK_COPY.emailFailedNoLink).toBe(NO_LINK);
    expect(COPY_LINK_COPY.emailFailedNoLink).toContain(`Select ${COPY_LINK_COPY.resend}.`);   // the button's own words
    // Created, link shown / no link shown.
    expect(createResult({ kind: 'saved', status: 201, body: CREATED }).status).toBe(`Created. ${COPY_LINK_COPY.emailFailed}`);
    const noLink = createResult({ kind: 'saved', status: 201, body: { ...CREATED, acceptUrl: null } });
    expect(noLink.status).toBe(`Created. ${NO_LINK}`);
    const noLinkHtml = view({ result: noLink, status: noLink.status, onResendWithLink: vi.fn() });
    expect(noLinkHtml).toMatch(new RegExp(`<button[^>]*>${COPY_LINK_COPY.resend}</button>`));   // the control the sentence names is there
    expect(noLinkHtml).not.toContain(COPY_LINK_COPY.emailFailed);
    // Resent from the link box: with the link (the box asks for it) / without one.
    if (noLink.kind !== 'created') throw new Error('expected created');
    const inv = { ...CREATED.invitation, id: 'inv-21' };
    expect(resentResult(noLink.response, { kind: 'saved', status: 201, body: { invitation: inv, acceptUrl: 'https://h/invitations/v', emailSent: false } }).status)
      .toBe(`Resent: the old link no longer works. ${COPY_LINK_COPY.emailFailed}`);
    expect(resentResult(noLink.response, { kind: 'saved', status: 201, body: { invitation: inv, acceptUrl: null, emailSent: false } }).status)
      .toBe(`Resent: the old link no longer works. ${NO_LINK}`);
  });

  it('UX-23 (answer Q21): in the owner invitation box the email-failed sentence names the link when the link is shown, and the button when it is not', async () => {
    const { issuedWords } = await import('@/components/admin/OwnerInvitationBox');
    const inv = { ...CREATED.invitation, id: 'inv-22' };
    expect(issuedWords({ invitation: inv, acceptUrl: 'https://h/invitations/w', emailSent: false })).toBe(`Invitation created. ${COPY_LINK_COPY.emailFailed}`);
    expect(issuedWords({ invitation: inv, acceptUrl: null, emailSent: false })).toBe(`Invitation created. ${COPY_LINK_COPY.emailFailedNoLink}`);
    expect(issuedWords({ invitation: inv, acceptUrl: null, emailSent: true })).toBe(ADMIN_FORMS_COPY.invitation.sent(inv.email));
    expect(resendWords({ kind: 'saved', status: 201, body: { invitation: inv, acceptUrl: 'https://h/invitations/w', emailSent: false } }))
      .toBe(`Resent: the old link no longer works. ${COPY_LINK_COPY.emailFailed}`);
    expect(resendWords({ kind: 'saved', status: 201, body: { invitation: inv, acceptUrl: null, emailSent: false } }))
      .toBe(`Resent: the old link no longer works. ${COPY_LINK_COPY.emailFailedNoLink}`);
  });

  it('UX-23 (answer Q22): on the create screen a refused resend points at "Open the organisation", never at a reload', () => {
    const created = createResult({ kind: 'saved', status: 201, body: { ...CREATED, acceptUrl: null } });
    if (created.kind !== 'created') throw new Error('expected created');
    const refusedWith = (out: Parameters<typeof resentResult>[1]) => resentResult(created.response, out).status;
    const R = ADMIN_FORMS_COPY.create.resendRefusals;
    expect(refusedWith({ kind: 'not_saved', reason: 'network' })).toBe('The connection was lost, so we do not know if this worked. Open the organisation to check before you try again.');
    expect(refusedWith({ kind: 'not_saved', reason: 'network' })).toBe(R.lostReply);
    expect(refusedWith({ kind: 'rejected', status: 500, body: { error: 'x', code: 'internal' } })).toBe('Not done. The server had a problem. Open the organisation and try again.');
    expect(refusedWith({ kind: 'rejected', status: 409, body: { error: 'x', code: 'invitation_not_pending' } })).toBe('That invitation was already accepted, cancelled or expired. Open the organisation to see its state.');
    expect(refusedWith({ kind: 'rejected', status: 404, body: { error: 'x', code: 'not_found' } })).toBe('That invitation no longer exists. Open the organisation.');
    expect(refusedWith({ kind: 'rejected', status: 409, body: { error: 'x', code: 'something_else' } })).toBe('Not done. Open the organisation and try again.');
    // Each names the link that is on the screen, by its own words.
    for (const sentence of Object.values(R)) expect(sentence).toContain(ADMIN_FORMS_COPY.create.open);
    const html = view({ result: resentResult(created.response, { kind: 'not_saved', reason: 'network' }), status: R.lostReply, onResendWithLink: vi.fn() });
    expect(html).toMatch(new RegExp(`<a[^>]*>${ADMIN_FORMS_COPY.create.open}</a>`));
    // The other refusals are the same on both screens.
    expect(refusedWith({ kind: 'rejected', status: 401, body: { error: 'x', code: 'unauthenticated' } })).toBe(ADMIN_FORMS_COPY.invitation.signedOut);
    expect(refusedWith({ kind: 'rejected', status: 409, body: { error: 'x', code: 'active_owner_exists' } })).toBe(ADMIN_FORMS_COPY.invitation.activeOwner);
    expect(refusedWith({ kind: 'rejected', status: 409, body: { error: 'x', code: 'pending_owner_invitation_exists' } })).toBe(ADMIN_FORMS_COPY.invitation.pendingExists);
    expect(refusedWith({ kind: 'rejected', status: 409, body: { error: 'x', code: 'organisation_archived' } })).toBe(ADMIN_FORMS_COPY.invitation.archived);
    expect(refusedWith({ kind: 'rejected', status: 422, body: { error: 'x', code: 'validation' } })).toBe(ADMIN_FORMS_COPY.invitation.checkFields);
  });

  it('UX-23 (answer Q22): the organisation page keeps its refusals of an owner invitation write, which say "Reload the page"', async () => {
    const { invitationRefusal } = await import('@/components/admin/CreateOrganisationForm');
    expect(invitationRefusal({ kind: 'not_saved', reason: 'network' })).toBe('The connection was lost, so we do not know if this worked. Reload the page to check before you try again.');
    expect(invitationRefusal({ kind: 'rejected', status: 500, body: { error: 'x', code: 'internal' } })).toBe('Not done. The server had a problem. Reload the page and try again.');
    expect(invitationRefusal({ kind: 'rejected', status: 409, body: { error: 'x', code: 'invitation_not_pending' } })).toBe('That invitation was already accepted, cancelled or expired. Reload the page to see its state.');
    expect(invitationRefusal({ kind: 'rejected', status: 404, body: { error: 'x', code: 'not_found' } })).toBe('That invitation no longer exists. Reload the page.');
    expect(invitationRefusal({ kind: 'rejected', status: 409, body: { error: 'x', code: 'something_else' } })).toBe('Not done. Reload the page and try again.');
  });

  it('FR-ORG-01: S-24 shows the 7.4.2 saving, saved and failed texts exactly (SRS line 2387)', () => {
    expect(statusText(view({ status: ADMIN_FORMS_COPY.create.creating, busy: true }))).toBe(ADMIN_FORMS_COPY.create.creating);
    expect(createResult({ kind: 'saved', status: 201, body: { ...CREATED, emailSent: true, acceptUrl: null } }).status).toBe(ADMIN_FORMS_COPY.create.sent('head@fixture.test'));
    const failed = createResult({ kind: 'not_saved', reason: 'network' });
    expect(failed.status).toBe(ADMIN_FORMS_COPY.create.notCreated);
    const html = view({ result: failed, status: failed.status });
    expect(statusText(html)).toBe(ADMIN_FORMS_COPY.create.notCreated);
    expect(html).toMatch(/<button[^>]*>Retry<\/button>/);
    expect(createResult({ kind: 'rejected', status: 409, body: { error: 'x', code: 'slug_taken' } }).status)
      .toBe(ADMIN_FORMS_COPY.create.slugTaken);   // owner copy (ruling 3)
  });

  it('FR-ORG-01: the create form validates every field', () => {
    const e = createErrors(blank);
    expect(Object.keys(e).sort()).toEqual(['legalName', 'name', 'ownerEmail']);
    const html = view({ draft: blank, errors: e });
    for (const name of ['name', 'legalName', 'ownerEmail']) {
      const tag = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? '';
      expect(tag, name).toContain('aria-invalid="true"');
      expect(tag, name).toMatch(/aria-describedby="[^"]+"/);
    }
    expect(createErrors({ ...filled, legalName: 'x'.repeat(MAX_LEGAL_NAME + 1) }).legalName).toBe(`Use ${MAX_LEGAL_NAME} characters or fewer.`);
    expect(createErrors(filled)).toEqual({});
    const inputNamed = (name: string) => new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? '';
    expect(inputNamed('name')).toContain(`maxLength="${MAX_ORG_NAME}"`);
    expect(inputNamed('legalName')).toContain(`maxLength="${MAX_LEGAL_NAME}"`);
    expect(html).toContain('Create one organisation for each team whose members may read each other&#x27;s records. An institution with several teams gets one organisation for each.');
    expect(html).toContain(ADMIN_FORMS_COPY.create.note.replaceAll("'", '&#x27;'));
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Create organisation and send invitation<\/button>/);
  });

  it('S-24 create posts name, legalName, ownerEmail and showLink, and has no agreement field', async () => {
    const { escapeRe } = await import('../helpers/escapeRe');
    expect(createFields({ name: '  Makerere CAI Lab ', legalName: ' Makerere University  ', ownerEmail: ' head@fixture.test ', showLink: true }))
      .toEqual({ name: 'Makerere CAI Lab', legalName: 'Makerere University', ownerEmail: 'head@fixture.test', showLink: true });
    const html = view({ draft: blank });
    const labelFor = (label: string) => new RegExp(`<label[^>]*for="([^"]+)"[^>]*>${escapeRe(label)}(?: <span[^>]*>[^<]*</span>)?</label>`).exec(html)?.[1];
    for (const label of [ADMIN_FORMS_COPY.create.nameLabel, ADMIN_FORMS_COPY.create.legalNameLabel, ADMIN_FORMS_COPY.create.ownerEmailLabel, ADMIN_FORMS_COPY.create.showLink]) expect(labelFor(label.replaceAll("'", '&#x27;')), label).toBeTruthy();
    // The legal name's hint is the field's description (aria-describedby names the hint's id).
    const legalId = labelFor("Institution&#x27;s legal name")!;
    expect(html).toMatch(new RegExp(`<div[^>]*id="${legalId}-hint"`));
    expect(html).toContain('The registered name of the university, hospital or institute the team belongs to.');
    expect(new RegExp(`<input[^>]*id="${legalId}"[^>]*aria-describedby="${legalId}-hint"`).test(html)).toBe(true);
    expect([...html.matchAll(/<(?:input|select|textarea)[^>]*\sname="([^"]+)"/g)].map((m) => m[1])).toEqual(['name', 'legalName', 'ownerEmail', 'showLink']);
    expect(html).not.toMatch(/agreement|Controller|Data-protection|Read this version|<select|<legend/i);
  });

  it('FR-ORG-01: the parser behind the route accepts a legal name of MAX_LEGAL_NAME characters and refuses one more', async () => {
    const { parseCorrectOrganisation } = await vi.importActual<typeof import('@/lib/data/admin')>('@/lib/data/admin');
    expect(parseCorrectOrganisation({ legalName: 'x'.repeat(MAX_LEGAL_NAME) })).toEqual({ legalName: 'x'.repeat(MAX_LEGAL_NAME) });
    expect(() => parseCorrectOrganisation({ legalName: 'x'.repeat(MAX_LEGAL_NAME + 1) })).toThrow();
  });

  it('FR-ORG-02 FR-ACC-10 (helper): S-24 offers a new first-owner invitation only without an active owner, and marks a copied-link account', () => {
    const inv = { ...CREATED.invitation, id: 'inv-1' };
    const renderBox = (p: { hasActiveOwner: boolean; invitations: (typeof inv & { createdFromShownLink?: boolean })[] }) =>
      renderToStaticMarkup(<OwnerInvitationBox orgId="org-1" {...p} />);
    expect(renderBox({ hasActiveOwner: true, invitations: [] })).not.toContain(ADMIN_FORMS_COPY.invitation.sendNew);
    expect(renderBox({ hasActiveOwner: false, invitations: [] })).toContain(ADMIN_FORMS_COPY.invitation.sendNew);
    const pending = renderBox({ hasActiveOwner: false, invitations: [inv] });
    expect(pending).not.toContain(ADMIN_FORMS_COPY.invitation.sendNew);
    for (const text of [ADMIN_FORMS_COPY.invitation.resend, ADMIN_FORMS_COPY.invitation.resendHint, ADMIN_FORMS_COPY.invitation.cancelTrigger, 'Pending']) expect(pending).toContain(text);
    expect(statusText(pending)).toBe('');   // the box's region is mounted before any result
    const accepted = renderBox({ hasActiveOwner: true, invitations: [{ ...inv, state: 'accepted', linkShown: true, createdFromShownLink: true }] });
    expect(accepted).toContain('account created from a copied link');
    expect(accepted).toContain('Accepted');
    expect(renderBox({ hasActiveOwner: true, invitations: [{ ...inv, state: 'accepted', createdFromShownLink: false }] })).not.toContain('copied link');
  });

  it('UX-23: every S-24 link box is keyed by its invitation and leaves the email-failure sentence to the screen (MEM CR-1, R-6)', () => {
    for (const file of ['components/admin/CreateOrganisationForm.tsx', 'components/admin/OwnerInvitationBox.tsx']) {
      const src = readFileSync(file, 'utf8');
      const boxes = src.match(/<CopyLinkFallback[^>]*>/g) ?? [];
      expect(boxes.length, file).toBeGreaterThan(0);
      for (const b of boxes) {
        expect(b, file).toMatch(/key=\{[^}]*invitation\.id\}/);
        expect(b, file).toContain('noticeShownElsewhere');
        expect(b, file).toContain('onResendWithLink=');   // an email that failed with no link shown can still be recovered here
      }
    }
  });

  it('S-24 detail lists earlier agreement records read-only, with no record button', async () => {
    const V1 = { id: 'a1', agreementVersion: '1', textHash: 'a'.repeat(64), acceptedOn: '2026-10-27', controllerLegalName: 'Makerere University', dpContactEmail: 'dpo@fixture.test', recordedAt: '2026-10-28T07:12:00.000Z' };
    const html = renderToStaticMarkup(<AgreementRecords agreements={[V1]} />);
    expect(html).toContain('>Earlier agreement records (no longer used)</h2>');
    expect(html).toContain('v1 · accepted 27 Oct 2026 · controller Makerere University · dpo@fixture.test · recorded on 28 Oct 2026');
    expect(html).not.toMatch(/<(button|form|input|select|a)[\s>]/);
    expect(html).not.toMatch(/Record|Current/);
    expect(renderToStaticMarkup(<AgreementRecords agreements={[]} />)).toBe('');
    // On the page: shown when rows exist, absent when none.
    requireIdentityMock.mockResolvedValue(adminIdentity);
    organisationMock.mockResolvedValue({ row: row(), agreements: [V1], ownerInvitations: [] });
    const page = renderToStaticMarkup(await OrganisationPage({ params: Promise.resolve({ id: 'org-1' }) }));
    expect(page).toContain('Earlier agreement records (no longer used)');
    expect(page).not.toMatch(/Record (its|a newer) agreement|No agreement recorded|Agreement records/);
    organisationMock.mockResolvedValue({ row: row(), agreements: [], ownerInvitations: [] });
    expect(renderToStaticMarkup(await OrganisationPage({ params: Promise.resolve({ id: 'org-1' }) }))).not.toContain('Earlier agreement records');
  });

  it('FR-ORG-10: S-24 offers the legal-name correction and posts { legalName }', async () => {
    expect(correctLegalNameError('', 'Makerere University')).toBe("Enter the institution's legal name.");
    expect(correctLegalNameError('x'.repeat(MAX_LEGAL_NAME + 1), null)).toBe(`Use ${MAX_LEGAL_NAME} characters or fewer.`);
    expect(correctLegalNameError(' Makerere University ', 'Makerere University')).toBe("This is already the institution's legal name.");
    expect(correctLegalNameError('Makerere University', null)).toBeUndefined();
    const sent: Record<string, unknown>[] = [];
    const send = vi.fn(async (body: Record<string, unknown>) => { sent.push(body); return { kind: 'saved' as const, status: 200, body: { previousLegalName: 'Old University' } }; });
    const done = await correctLegalName('  Makerere University ', 'Old University', send);
    expect(sent).toEqual([{ legalName: 'Makerere University' }]);   // exactly one key: never { name }
    expect(done).toEqual({ kind: 'done', status: ADMIN_FORMS_COPY.legalName.saved('Makerere University', 'Old University'), saved: true });
    const first = await correctLegalName('Makerere University', null, async () => ({ kind: 'saved' as const, status: 200, body: { previousLegalName: null } }));
    expect(first).toEqual({ kind: 'done', status: ADMIN_FORMS_COPY.legalName.savedFirst('Makerere University'), saved: true });
    expect(await correctLegalName('Makerere University', 'Makerere University', send)).toMatchObject({ kind: 'invalid' });
    expect(send).toHaveBeenCalledTimes(1);   // the unchanged value was not sent
    // The parser's "one at a time" error arrives on field `name` whichever key was wrong: it is shown at form level, not at the input.
    const oneAtATime = await correctLegalName('Makerere University', null, async () => ({ kind: 'rejected' as const, status: 422,
      body: { error: 'x', code: 'validation', fields: [{ field: 'name', message: 'Correct the name or the legal name, one at a time.' }] } }));
    expect(oneAtATime).toEqual({ kind: 'done', status: 'Not saved. Reload the page and try again.', saved: false });
    const fieldError = await correctLegalName('Makerere University', null, async () => ({ kind: 'rejected' as const, status: 422,
      body: { error: 'x', code: 'validation', fields: [{ field: 'legalName', message: 'Use 200 characters or fewer.' }] } }));
    expect(fieldError).toEqual({ kind: 'invalid', error: 'Use 200 characters or fewer.' });
    // The view: label, hint tied by aria-describedby, announced status region, and the error beside the input it belongs to.
    const html = renderToStaticMarkup(<CorrectLegalNameView formId="f" open value="Old" error="Enter the institution's legal name." status="" busy={false}
      onOpen={vi.fn()} onValue={vi.fn()} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(html).toMatch(/<label[^>]*for="f-legal-name"[^>]*>Institution&#x27;s legal name <span[^>]*>\(required\)<\/span><\/label>/);
    expect(html).toMatch(/<input[^>]*id="f-legal-name"[^>]*aria-describedby="f-legal-name-hint f-legal-name-error"/);
    expect(html).toContain('The registered name of the university, hospital or institute the team belongs to.');
    expect(html).toMatch(/<span id="f-legal-name-error">Enter the institution&#x27;s legal name\.<\/span>/);   // the error message the input points at
    expect(html).toMatch(/<div role="status"/);
    expect(renderToStaticMarkup(<CorrectLegalNameView formId="f" open={false} value="" error={undefined} status="" busy={false}
      onOpen={vi.fn()} onValue={vi.fn()} onSubmit={vi.fn()} onCancel={vi.fn()} />)).toMatch(new RegExp(`>${ADMIN_FORMS_COPY.legalName.change}</button>`));
    // Beside today's name correction on the page.
    requireIdentityMock.mockResolvedValue(adminIdentity);
    organisationMock.mockResolvedValue({ row: row(), agreements: [], ownerInvitations: [] });
    const page = renderToStaticMarkup(await OrganisationPage({ params: Promise.resolve({ id: 'org-1' }) }));
    expect(page).toMatch(new RegExp(`>${ADMIN_FORMS_COPY.name.change}</button>`));
    expect(page).toMatch(new RegExp(`>${ADMIN_FORMS_COPY.legalName.change}</button>`));
  });

  it('FR-ORG-10: a legal name already corrected elsewhere (the route answers 200 with the same value) says it is already the name, not that it was saved', async () => {
    const stale = await correctLegalName(' Makerere University ', 'Old University', async () => ({ kind: 'saved' as const, status: 200, body: { previousLegalName: 'Makerere University' } }));
    expect(stale).toEqual({ kind: 'done', saved: false, unchanged: true, status: UNCHANGED_LEGAL_NAME });
    expect(UNCHANGED_LEGAL_NAME).toBe(correctLegalNameError('Makerere University', 'Makerere University'));   // the sentence the client's own refusal uses
    expect(stale.kind === 'done' && stale.status).not.toMatch(/Saved|it was/);
  });

  it('FR-ORG-10: Cancel on the legal-name form clears the value, the field error and the status sentence that pointed at the field', () => {
    expect(cancelledForm('Makerere University')).toEqual({ open: false, error: undefined, value: 'Makerere University', status: '' });
    expect(cancelledForm(null)).toEqual({ open: false, error: undefined, value: '', status: '' });
  });

  it('FR-ORG-03: the S-24 pages give a non-administrator only the refusal line, and an unknown organisation S-31', async () => {
    requireIdentityMock.mockResolvedValue(assessorIdentity);
    for (const html of [renderToStaticMarkup(await NewOrganisationPage()), renderToStaticMarkup(await OrganisationPage({ params: Promise.resolve({ id: 'org-1' }) }))]) {
      expect(html).toContain(ADMIN_COPY.refusal.line);
      expect(html).not.toContain('<form');
    }
    expect(organisationMock).not.toHaveBeenCalled();
    requireIdentityMock.mockResolvedValue(adminIdentity);
    organisationMock.mockRejectedValue(new NotFoundError());
    await expect(OrganisationPage({ params: Promise.resolve({ id: 'nope' }) })).rejects.toMatchObject({ digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/) });
  });

  it('FR-ORG-03 FR-ORG-07: the S-24 detail shows the name, legal name, date, member count, flags and invitations, and nothing else', async () => {
    requireIdentityMock.mockResolvedValue(adminIdentity);
    organisationMock.mockResolvedValue({ row: row({ orgId: 'org-1', hasActiveOwner: false, memberCount: 4 }), agreements: [], ownerInvitations: [] });
    const html = renderToStaticMarkup(await OrganisationPage({ params: Promise.resolve({ id: 'org-1' }) }));
    expect(html).toMatch(/<h1[^>]*>Makerere CAI Lab<\/h1>/);
    expect(html).toContain('Created 30 Oct 2026 · 4 members');
    expect(html).toContain(ADMIN_COPY.organisations.noActiveOwner);
    expect(html).toContain(ADMIN_FORMS_COPY.invitation.sendNew);
    expect(html).toContain(ADMIN_COPY.organisation.legalName('Makerere University'));
    expect(html).not.toMatch(/project|finding|decision|seal/i);
    organisationMock.mockResolvedValue({ row: row({ legalName: null }), agreements: [], ownerInvitations: [] });
    expect(renderToStaticMarkup(await OrganisationPage({ params: Promise.resolve({ id: 'org-1' }) }))).toContain('Legal name not recorded');
    requireIdentityMock.mockResolvedValue(adminIdentity);
    const created = renderToStaticMarkup(await NewOrganisationPage());
    expect(created).toMatch(/<h1[^>]*>Create an organisation<\/h1>/);
    expect(created).not.toContain('Only do this after');
    expect(created).not.toMatch(/agreement/i);
  });

  it('FR-ORG-03 (ruling L5-13): the organisation page\'s title names the organisation for the administrator only, after the same gate as the page', async () => {
    const { generateMetadata } = await import('@/app/(authenticated)/admin/organisations/[id]/page');
    const titleOf = async (id: string) => (await generateMetadata({ params: Promise.resolve({ id }) })).title;
    // The administrator, an organisation that exists: the thing, the organisation's name, the product.
    requireIdentityMock.mockResolvedValue(adminIdentity);
    organisationMock.mockResolvedValue({ row: row({ name: 'Makerere CAI Lab' }), agreements: [], ownerInvitations: [] });
    expect(await titleOf('org-1')).toBe(`${ADMIN_COPY.titles.organisation} · Makerere CAI Lab · MAK-AI RAI Platform`);
    // Not the administrator: the static title, and the organisation is never read.
    organisationMock.mockClear();
    requireIdentityMock.mockResolvedValue(assessorIdentity);
    expect(await titleOf('org-1')).toBe(`${ADMIN_COPY.titles.organisation} · MAK-AI RAI Platform`);
    expect(organisationMock).not.toHaveBeenCalled();
    // The administrator, an unknown id: the same static title, with no name and no error.
    requireIdentityMock.mockResolvedValue(adminIdentity);
    organisationMock.mockRejectedValue(new NotFoundError());
    expect(await titleOf('nope')).toBe(`${ADMIN_COPY.titles.organisation} · MAK-AI RAI Platform`);
    // Any other failure of the read is not turned into a title: it propagates as the page's own read would.
    organisationMock.mockRejectedValue(new Error('database down'));
    await expect(titleOf('org-1')).rejects.toThrow('database down');
  });
});
