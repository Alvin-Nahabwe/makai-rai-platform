import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AdminOrganisationRow } from '@/types/api';
import { ADMIN_COPY } from '@/lib/admin/copy';

/**
 * Lane 6 B5, rows S1 and S2 (R1 sweep, source 4): on the administrator's organisation page (S-24 detail), "archived" and
 * "No active Owner" each show as their own short label under the summary line, never joined to it with " · ". The page is
 * rendered to markup (vitest has no DOM library); its two reads are mocked, as in admin-screens.test.tsx.
 */

const requireIdentityMock = vi.hoisted(() => vi.fn());
const organisationMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: requireIdentityMock }));
vi.mock('@/lib/data/admin', () => ({ listOrganisationsForAdmin: vi.fn(), accountsForAdmin: vi.fn(), organisationForAdmin: organisationMock }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const { default: OrganisationPage } = await import('@/app/(authenticated)/admin/organisations/[id]/page');

const row = (over: Partial<AdminOrganisationRow> = {}): AdminOrganisationRow => ({
  orgId: 'org-1', name: 'Makerere CAI Lab', createdAt: '2026-10-30T09:00:00.000Z', legalName: 'Makerere University',
  memberCount: 4, ownerInvitationState: 'accepted', hasActiveOwner: true, archived: false, ...over,
});

async function pageFor(over: Partial<AdminOrganisationRow>): Promise<string> {
  requireIdentityMock.mockResolvedValue({ userId: 'admin-1', email: 'a@fixture.test', name: 'A', platformRole: 'admin', mustChangePassword: false });
  organisationMock.mockResolvedValue({ row: row(over), agreements: [], ownerInvitations: [] });
  return renderToStaticMarkup(await OrganisationPage({ params: Promise.resolve({ id: 'org-1' }) }));
}

/** The paragraph under the h1: the summary line and any state labels. */
const summaryOf = (html: string): string => /<\/header><p>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';

describe('S-24 detail: the organisation\'s states as labels (S1, S2)', () => {
  const O = ADMIN_COPY.organisation;
  const summary = O.summary('30 Oct 2026', 4);

  it('S2: an archived organisation shows "Archived" as its own label after the summary line, with no " · " join', async () => {
    const p = summaryOf(await pageFor({ archived: true }));
    expect(p).toBe(`${summary}<span class="admin-flag">${O.archived}</span>`);
    expect(O.archived).toBe('Archived');
  });

  it('S1: an organisation with no active Owner shows that as its own strong label, with no " · " join', async () => {
    const p = summaryOf(await pageFor({ hasActiveOwner: false }));
    expect(p).toBe(`${summary}<strong class="admin-flag">${ADMIN_COPY.organisations.noActiveOwner}</strong>`);
  });

  it('S1 S2: both states show as two labels, archived first, and an organisation with neither shows only the summary line', async () => {
    expect(summaryOf(await pageFor({ archived: true, hasActiveOwner: false }))).toBe(
      `${summary}<span class="admin-flag">${O.archived}</span><strong class="admin-flag">${ADMIN_COPY.organisations.noActiveOwner}</strong>`,
    );
    const plain = summaryOf(await pageFor({}));
    expect(plain).toBe(summary);
    expect(plain).not.toMatch(/ · (archived|No active Owner)/);
  });
});
