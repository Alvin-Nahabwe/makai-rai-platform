import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Identity } from '@/lib/auth/identity';
import type { AdminOrganisationRow } from '@/types/api';
import type { AdminAccountRow } from '@/lib/data/admin';
import type { InvitationState } from '@/types/record';

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
const { default: Sidebar } = await import('@/components/layout/Sidebar');
const { default: NewOrganisationPage } = await import('@/app/(authenticated)/admin/organisations/new/page');
const { default: OrganisationPage } = await import('@/app/(authenticated)/admin/organisations/[id]/page');
const { CreateOrganisationFormView, createErrors, createResult, resentResult, EMPTY_AGREEMENT, EMAIL_FAILED, ALREADY_RESENT, ALREADY_CREATED } = await import('@/components/admin/CreateOrganisationForm');
const { OwnerInvitationBox, resendWords } = await import('@/components/admin/OwnerInvitationBox');
const { correctNameError } = await import('@/components/admin/CorrectNameForm');
const { AgreementRecords } = await import('@/components/admin/AgreementRecords');
const { NotFoundError } = await import('@/lib/data/tenant');

const identity = (platformRole: 'admin' | 'assessor', userId = `${platformRole}-1`): Identity =>
  ({ userId, email: `${userId}@fixture.test`, name: userId, platformRole, mustChangePassword: false }) as Identity;
const adminIdentity = identity('admin');
const assessorIdentity = identity('assessor');
const noOrgIdentity = identity('assessor', 'no-org-1');

const row = (over: Partial<AdminOrganisationRow> = {}): AdminOrganisationRow => ({
  orgId: 'org-1', name: 'Makerere CAI Lab', createdAt: '2026-10-30T09:00:00.000Z', currentAgreementVersion: '1',
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
    expect(html).toContain('You are not in an organisation yet: ask its owner for an invitation.');
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
  it('FR-ORG-06 FR-ORG-07: S-23 flags a missing agreement and a missing active owner, in words', async () => {
    const html = await renderS23([row({ orgId: 'o-a', name: 'No Agreement Lab', currentAgreementVersion: null }), row({ orgId: 'o-b', name: 'No Owner Lab', hasActiveOwner: false, ownerInvitationState: 'expired' })]);
    expect(html).toContain('No agreement recorded');
    expect(html).toContain('No active owner');
    expect(html).toContain('Expired');
    expect(html).toContain('<caption');
    for (const col of ['Organisation', 'Created', 'Current agreement', 'Members', 'First-owner invitation'])
      expect(html).toMatch(new RegExp(`<th scope="col"[^>]*>${col}</th>`));
    expect(html).toContain('href="/admin/organisations/o-a"');
    expect(html).toContain('30 Oct 2026');
  });

  it('FR-ORG-03: S-23 shows the 7.4.2 empty state and a non-administrator gets only the refusal line (SRS line 2387)', async () => {
    const empty = await renderS23([]);
    expect(empty).toContain('No organisations yet. Create one after its agreement is signed.');
    expect(empty).toMatch(/<a [^>]*href="\/admin\/organisations\/new"[^>]*>Create organisation<\/a>/);
    expect(empty).not.toContain('<table');
    for (const page of [renderS23Page, renderS25Page]) {
      listOrganisationsMock.mockClear(); accountsMock.mockClear();
      const html = await page(assessorIdentity);
      expect(html).toContain('This page is for MAK-AI administrators.');
      expect(html).not.toContain('<table');
      expect(listOrganisationsMock).not.toHaveBeenCalled();
      expect(accountsMock).not.toHaveBeenCalled();
    }
  });
});

describe('S-25, accounts', () => {
  it('FR-ORG-07: S-25 warns before deactivating an only active owner, naming the organisation', async () => {
    const html = await renderS25([acct({ onlyActiveOwnerOf: ['Makerere CAI Lab'] })]);
    expect(html).toMatch(/Grace Nakato is the only active owner of Makerere CAI Lab\. Deactivating needs the reference of the controller&#x27;s written request\./);
    const field = /<input[^>]*name="requestReference"[^>]*>/.exec(html)?.[0] ?? '';
    expect(field).toMatch(/\brequired\b/);
    expect(field).toMatch(/maxlength="200"/i);
    expect(field).toMatch(/aria-describedby="only-owner-u-2"/);
    const plain = await renderS25([acct()]);
    expect(plain).not.toContain('only active owner');
    expect(plain).not.toContain('name="requestReference"');
  });

  it('FR-ORG-07 NFR-SEC-19: S-25 lives at /admin/accounts and shows one banner per refusal code', async () => {
    expect(existsSync('app/(authenticated)/admin/accounts/page.tsx')).toBe(true);
    expect(existsSync('app/(authenticated)/admin/users/page.tsx')).toBe(false);
    expect(existsSync('app/(authenticated)/admin/settings/page.tsx')).toBe(false);
    const banners = new Map<string, string>();
    for (const code of ['self', 'request_reference_required', 'has_membership', 'single_admin']) {
      const html = await renderS25([acct()], { error: code });
      expect(html, code).toMatch(/role="alert"|role="status"/);
      banners.set(code, html);
    }
    expect(banners.get('self')).toContain('You cannot change your own role or deactivate your own account.');
    expect(banners.get('request_reference_required')).toContain('Enter the reference of the controller&#x27;s written request to deactivate the only active owner.');
    expect(banners.get('has_membership')).toContain('This account belongs to an organisation, so it cannot be a MAK-AI administrator.');
    expect(banners.get('single_admin')).toContain('The platform keeps one MAK-AI administrator. This account stays an assessor.');
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
    const html = renderToStaticMarkup(<Sidebar userName="A" userId="a-1" roleLabels={{}} platformLabel="MAK-AI administrator" orgCount={0} />);
    expect(html).toMatch(/<a [^>]*href="\/admin\/organisations"[^>]*>Organisations<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/admin\/accounts"[^>]*>Accounts<\/a>/);
    expect(html).not.toMatch(/>Settings<\/a>/);
    expect(html).not.toContain('/admin/users');
  });
});

// ── S-24 (Task 8) ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('S-24, creating and recovering an organisation', () => {
  const VERSIONS = [{ version: '1', publishedOn: '2026-10-20', sha256: 'a'.repeat(64) }];
  const blank = { ...EMPTY_AGREEMENT, name: '', ownerEmail: '', showLink: false };
  const filled = { name: 'Makerere CAI Lab', version: '1', day: '27', month: '10', year: '2026', controllerLegalName: 'Makerere University',
    dpContactEmail: 'dpo@fixture.test', ownerEmail: 'head@fixture.test', showLink: true };
  const CREATED = {
    orgId: 'org-9', slug: 'makerere-cai-lab', acceptUrl: 'https://h/invitations/t', emailSent: false,
    invitation: { id: 'inv-9', email: 'head@fixture.test', role: 'owner' as const, kind: 'first_owner' as const, state: 'pending' as InvitationState,
      expiresAt: '2026-11-03T09:00:00.000Z', createdAt: '2026-10-27T09:00:00.000Z', linkShown: true },
  };
  const view = (over: Partial<Parameters<typeof CreateOrganisationFormView>[0]> = {}) => renderToStaticMarkup(
    <CreateOrganisationFormView draft={filled} errors={{}} versions={VERSIONS} status="" busy={false} result={null}
      onChange={vi.fn()} onSubmit={vi.fn()} onRetry={vi.fn()} {...over} />);
  /** The text inside the page's status region, which must exist before any result is put in it. */
  const statusText = (html: string) => /<div role="status"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1];

  it('UX-23 FR-ORG-02: after creation S-24 shows the copy link and the expiry, and the email failure sentence in the region that was there before', () => {
    expect(statusText(view())).toBe('');   // mounted, empty, before the send
    const result = createResult({ kind: 'saved', status: 201, body: CREATED });
    const html = view({ result, status: result.status });
    expect(statusText(html)).toBe(`Created. ${EMAIL_FAILED}`);
    expect(html.split(EMAIL_FAILED)).toHaveLength(2);   // once, in the status region: the link box does not print it again
    expect(html).toMatch(/<button[^>]*>Copy link<\/button>/);
    expect(html).toContain('https://h/invitations/t');
    expect(html).toContain('The link works once and expires on 3 Nov 2026.');
    expect(html).not.toContain('<form');
  });

  it('UX-23 NFR-INT-02 (C4 CR-1): a replayed resend (200) says it was already resent, not that the email failed, and opens no link box', () => {
    expect(ALREADY_RESENT).toBe('This invitation was already resent. If the email did not arrive, use Resend again.');
    const inv = { ...CREATED.invitation, id: 'inv-11' };
    expect(resendWords({ kind: 'saved', status: 200, body: { invitation: inv, acceptUrl: null, emailSent: false } })).toBe(ALREADY_RESENT);
    expect(resendWords({ kind: 'saved', status: 201, body: { invitation: inv, acceptUrl: null, emailSent: false } })).toBe(`Resent: the old link no longer works. ${EMAIL_FAILED}`);
    expect(resendWords({ kind: 'saved', status: 201, body: { invitation: inv, acceptUrl: null, emailSent: true } })).toBe(`Resent: the old link no longer works. Invitation sent to ${inv.email}.`);
    const created = createResult({ kind: 'saved', status: 201, body: { ...CREATED, acceptUrl: null } });
    if (created.kind !== 'created') throw new Error('expected created');
    const replay = resentResult(created.response, { kind: 'saved', status: 200, body: { invitation: inv, acceptUrl: null, emailSent: false } });
    expect(replay.status).toBe(ALREADY_RESENT);
    const html = view({ result: replay, status: replay.status, onResendWithLink: vi.fn() });
    expect(html).not.toContain('Resend and show link');
    expect(html).not.toContain('Invitation link');
    expect(html.split(EMAIL_FAILED)).toHaveLength(1);
  });

  it('UX-23 NFR-INT-02: a replayed create (200) says the organisation was already created, not that the email failed, and opens no link box', () => {
    expect(ALREADY_CREATED).toBe('This organisation was already created. If the email did not arrive, use Resend.');
    const replay = createResult({ kind: 'saved', status: 200, body: { ...CREATED, acceptUrl: null, emailSent: false } });
    expect(replay.status).toBe(ALREADY_CREATED);
    const html = view({ result: replay, status: replay.status, onResendWithLink: vi.fn() });
    expect(statusText(html)).toBe(ALREADY_CREATED);
    expect(html).not.toContain('Resend and show link');
    expect(html).not.toContain('Invitation link');
    expect(html).toContain('Open the organisation');
  });

  it('FR-ORG-10 (C4 ORG-SF-4): the name correction refuses the name the organisation already has', () => {
    expect(correctNameError('Makerere CAI Lab', 'Makerere CAI Lab')).toBe("This is already the organisation's name.");
    expect(correctNameError('  Makerere CAI Lab ', 'Makerere CAI Lab')).toBe("This is already the organisation's name.");
    expect(correctNameError('', 'Makerere CAI Lab')).toBe('Enter the corrected name.');
    expect(correctNameError('x'.repeat(101), 'Makerere CAI Lab')).toBe('Use 100 characters or fewer.');
    expect(correctNameError('Makerere CAI Laboratory', 'Makerere CAI Lab')).toBeUndefined();
  });

  it('FR-ORG-02 FR-ORG-04 (C4 ORG-SF-5): for an archived organisation S-24 offers no Issue, Resend or Revoke and says it is archived', () => {
    const inv = { ...CREATED.invitation, id: 'inv-12' };
    const live = renderToStaticMarkup(<OwnerInvitationBox orgId="org-1" hasActiveOwner={false} invitations={[inv]} archived={false} />);
    expect(live).toContain('Resend invitation');
    for (const invitations of [[inv], []]) {
      const html = renderToStaticMarkup(<OwnerInvitationBox orgId="org-1" hasActiveOwner={false} invitations={invitations} archived />);
      expect(html).toContain('This organisation is archived.');
      for (const action of ['Resend invitation', 'Revoke invitation', 'Issue a new first-owner invitation']) expect(html).not.toContain(action);
    }
  });

  it('UX-23 FR-ORG-02: when the email failed and no link was shown, S-24 offers Resend and show link, and the resend shows the new link', () => {
    const noLink = createResult({ kind: 'saved', status: 201, body: { ...CREATED, acceptUrl: null, invitation: { ...CREATED.invitation, linkShown: false } } });
    const html = view({ result: noLink, status: noLink.status, onResendWithLink: vi.fn() });
    expect(statusText(html)).toBe(`Created. ${EMAIL_FAILED}`);
    expect(html).toMatch(/<button[^>]*>Resend and show link<\/button>/);
    expect(html).not.toContain('Invitation link');
    if (noLink.kind !== 'created') throw new Error('expected created');
    const resentInv = { ...CREATED.invitation, id: 'inv-10', linkShown: true };
    const resent = resentResult(noLink.response, { kind: 'saved', status: 201, body: { invitation: resentInv, acceptUrl: 'https://h/invitations/u', emailSent: false } });
    expect(resent.status).toBe(`Resent: the old link no longer works. ${EMAIL_FAILED}`);
    if (resent.kind !== 'created') throw new Error('expected created');
    expect(resent.response).toMatchObject({ orgId: 'org-9', slug: 'makerere-cai-lab', acceptUrl: 'https://h/invitations/u', invitation: { id: 'inv-10' } });
    const after = view({ result: resent, status: resent.status, onResendWithLink: vi.fn() });
    expect(after).toContain('https://h/invitations/u');
    expect(after).not.toContain('Resend and show link');
    const refused = resentResult(noLink.response, { kind: 'rejected', status: 409, body: { error: 'x', code: 'invitation_not_pending' } });
    expect(refused.kind).toBe('created');   // the organisation stays created; only the resend was refused
    expect(refused.status).toBe('That invitation is no longer pending. Reload the page.');
  });

  it('FR-ORG-01: S-24 shows the 7.4.2 saving, saved and failed texts exactly (SRS line 2387)', () => {
    expect(statusText(view({ status: 'Creating the organisation...', busy: true }))).toBe('Creating the organisation...');
    expect(createResult({ kind: 'saved', status: 201, body: { ...CREATED, emailSent: true, acceptUrl: null } }).status).toBe('Created. Invitation sent to head@fixture.test.');
    const failed = createResult({ kind: 'not_saved', reason: 'network' });
    expect(failed.status).toBe('Not created: connection lost. Nothing was created.');
    const html = view({ result: failed, status: failed.status });
    expect(statusText(html)).toBe('Not created: connection lost. Nothing was created.');
    expect(html).toMatch(/<button[^>]*>Retry<\/button>/);
    expect(createResult({ kind: 'rejected', status: 409, body: { error: 'x', code: 'slug_taken' } }).status)
      .toBe('Another organisation already uses this web address. Change the name slightly and try again.');   // owner copy (ruling 3)
  });

  it('FR-ORG-01: the create form validates every field and refuses an accepted date in the future', () => {
    const e = createErrors(blank, '2026-11-02', VERSIONS);
    expect(Object.keys(e).sort()).toEqual(['controllerLegalName', 'day', 'dpContactEmail', 'name', 'ownerEmail', 'version']);
    const html = view({ draft: blank, errors: e });
    for (const name of ['name', 'agreementVersion', 'day', 'month', 'year', 'controllerLegalName', 'dpContactEmail', 'ownerEmail']) {
      const tag = new RegExp(`<(input|select)[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? '';
      expect(tag, name).toContain('aria-invalid="true"');
      expect(tag, name).toMatch(/aria-describedby="[^"]+"/);
    }
    for (const label of ['Organisation name', 'Agreement version accepted', 'Day', 'Month', 'Year', 'Controller legal name', 'Data-protection contact email', "First owner&#x27;s email"])
      expect(html).toContain(`>${label}</label>`);
    expect(html).toContain('<legend');
    expect(html).toContain('Date the agreement was accepted');
    expect(createErrors({ ...filled, day: '3', month: '11', year: '2026' }, '2026-11-02', VERSIONS).day).toBe('The date the agreement was accepted cannot be after today.');
    expect(createErrors({ ...filled, day: '31', month: '2' }, '2026-11-02', VERSIONS).day).toMatch(/Enter the date/);
    expect(createErrors(filled, '2026-11-02', VERSIONS)).toEqual({});
    expect(html).toContain('Create one organisation for each team whose members may read each other&#x27;s records. An institution with several teams gets one organisation for each.');
    expect(html).toContain('Creating the organisation also records the agreement and sends an invitation to the first owner. If any part does not go through, nothing is created.');
    expect(html).toMatch(/<button type="submit"[^>]*>Create organisation and send invitation<\/button>/);
  });

  it('FR-ORG-02 FR-ACC-10 (helper): S-24 offers a new first-owner invitation only without an active owner, and marks a copied-link account', () => {
    const inv = { ...CREATED.invitation, id: 'inv-1' };
    const renderBox = (p: { hasActiveOwner: boolean; invitations: (typeof inv & { createdFromShownLink?: boolean })[] }) =>
      renderToStaticMarkup(<OwnerInvitationBox orgId="org-1" {...p} />);
    expect(renderBox({ hasActiveOwner: true, invitations: [] })).not.toContain('Issue a new first-owner invitation');
    expect(renderBox({ hasActiveOwner: false, invitations: [] })).toContain('Issue a new first-owner invitation');
    const pending = renderBox({ hasActiveOwner: false, invitations: [inv] });
    expect(pending).not.toContain('Issue a new first-owner invitation');
    for (const text of ['Resend invitation', '(makes a new link; the old one stops working)', 'Revoke invitation', 'Pending']) expect(pending).toContain(text);
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

  it('FR-ORG-05: agreement records are read-only and offer Record a newer agreement version', () => {
    const V1 = { id: 'a1', agreementVersion: '1', textHash: 'a'.repeat(64), acceptedOn: '2026-10-27', controllerLegalName: 'Makerere University', dpContactEmail: 'dpo@fixture.test', recordedAt: '2026-10-28T07:12:00.000Z' };
    const renderAgreements = (agreements: (typeof V1)[]) => renderToStaticMarkup(<AgreementRecords orgId="org-1" agreements={agreements} versions={VERSIONS} today="2026-11-02" />);
    const html = renderAgreements([V1]);
    expect(html).toContain('Record a newer agreement version');
    expect(html).not.toMatch(/<input[^>]*value="1"/);
    expect(html).not.toContain('<input');
    expect(html).toContain('v1 · accepted 27 Oct 2026 · controller Makerere University');
    expect(html).toContain('Current');
    const none = renderAgreements([]);
    expect(none).toContain('No agreement recorded. This organisation was created before agreements were recorded. It keeps working.');
    expect(none).toContain('Record its agreement');
  });

  it('FR-ORG-03: the S-24 pages give a non-administrator only the refusal line, and an unknown organisation S-31', async () => {
    requireIdentityMock.mockResolvedValue(assessorIdentity);
    for (const html of [renderToStaticMarkup(await NewOrganisationPage()), renderToStaticMarkup(await OrganisationPage({ params: Promise.resolve({ id: 'org-1' }) }))]) {
      expect(html).toContain('This page is for MAK-AI administrators.');
      expect(html).not.toContain('<form');
    }
    expect(organisationMock).not.toHaveBeenCalled();
    requireIdentityMock.mockResolvedValue(adminIdentity);
    organisationMock.mockRejectedValue(new NotFoundError());
    await expect(OrganisationPage({ params: Promise.resolve({ id: 'nope' }) })).rejects.toMatchObject({ digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/) });
  });

  it('FR-ORG-03 FR-ORG-07: the S-24 detail shows the name, date, member count, flags, agreements and invitations, and nothing else', async () => {
    requireIdentityMock.mockResolvedValue(adminIdentity);
    organisationMock.mockResolvedValue({ row: row({ orgId: 'org-1', hasActiveOwner: false, memberCount: 4 }), agreements: [], ownerInvitations: [] });
    const html = renderToStaticMarkup(await OrganisationPage({ params: Promise.resolve({ id: 'org-1' }) }));
    expect(html).toContain('<h1>Makerere CAI Lab</h1>');
    expect(html).toContain('Created 30 Oct 2026 · 4 members');
    expect(html).toContain('No active owner');
    expect(html).toContain('Issue a new first-owner invitation');
    expect(html).toContain('No agreement recorded.');
    expect(html).not.toMatch(/project|finding|decision|seal/i);
    requireIdentityMock.mockResolvedValue(adminIdentity);
    const created = renderToStaticMarkup(await NewOrganisationPage());
    expect(created).toContain('<h1>Create an organisation</h1>');
    expect(created).toContain('Only do this after the organisation and MAK-AI have signed the organisation agreement.');
    expect(created).toContain('Organisation agreement v1 (published 30 Oct 2026)');   // the stub registry's version (__tests__/setup/legal.ts)
  });
});
