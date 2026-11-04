import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Identity } from '@/lib/auth/identity';
import type { AdminOrganisationRow } from '@/types/api';
import type { AdminAccountRow } from '@/lib/data/admin';

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
const findUniqueMock = vi.hoisted(() => vi.fn());
const membershipsMock = vi.hoisted(() => vi.fn());
const readSessionDeadlines = vi.hoisted(() => vi.fn());
const pathnameMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/identity', () => ({ requireIdentity: requireIdentityMock }));
vi.mock('@/lib/data/admin', () => ({ listOrganisationsForAdmin: listOrganisationsMock, accountsForAdmin: accountsMock }));
vi.mock('@/lib/data/identity', () => ({ identityDb: { user: { findUnique: findUniqueMock } } }));
vi.mock('@/lib/data/preauth', () => ({ membershipsForUser: membershipsMock }));
vi.mock('@/lib/auth/idleDeadline', () => ({ readSessionDeadlines }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), usePathname: () => pathnameMock(),
}));
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

const { default: LandingPage } = await import('@/app/page');
const { default: OrganisationsPage } = await import('@/app/(authenticated)/admin/organisations/page');
const { default: AccountsPage } = await import('@/app/(authenticated)/admin/accounts/page');
const { default: Sidebar } = await import('@/components/layout/Sidebar');

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
