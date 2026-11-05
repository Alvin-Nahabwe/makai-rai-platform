import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InvitationView, MemberView } from '@/types/api';

/** S-22's page: it pages what the service returns (UX-40, UX-37) and gives pending invitations only to roles that may invite (obligation M10). The mocks stand in for the gate and the service, which other tests prove. */
const memberViews = (n: number): MemberView[] => Array.from({ length: n }, (_, i) => ({
  userId: `u-${i + 1}`, name: `Member ${String(i + 1).padStart(3, '0')}`, role: 'assessor', joinedAt: '2026-10-01T00:00:00.000Z', createdFromShownLink: false,
}));
const MARKER_EMAIL = 'zzmark-invitee-1-qx@fixture.test';
const invitation: InvitationView = {
  id: 'i-1', email: MARKER_EMAIL, role: 'viewer', kind: 'member', state: 'pending',
  expiresAt: '2026-11-11T09:00:00.000Z', createdAt: '2026-11-04T09:00:00.000Z', linkShown: false,
};
const state = vi.hoisted(() => ({ role: 'owner' }));
const listInvitations = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: async () => ({ userId: 'u-001' }) }));
vi.mock('@/lib/auth/context', () => ({ requireOrgContextFor: async () => ({ orgId: 'o-1', role: state.role }) }));
vi.mock('@/lib/data/members', () => ({ listMembers: async () => memberViews(60), listInvitations }));

const { default: MembersSettingsPage } = await import('@/app/(authenticated)/orgs/[slug]/settings/members/page');
const html = async (searchParams: { shown?: string }) =>
  renderToStaticMarkup(await MembersSettingsPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve(searchParams) }));

beforeEach(() => { state.role = 'owner'; listInvitations.mockReset(); listInvitations.mockResolvedValue([invitation]); });

describe('S-22 page', () => {
  it('UX-40 UX-37 FR-MEM-02: S-22 shows 50 members and a "Show more" link to ?shown=100, then all 60 and no link', async () => {
    const first = await html({});
    expect(new Set(first.match(/Member \d{3}/g)).size).toBe(50);
    expect(first).toMatch(/<a [^>]*href="\?shown=100"[^>]*>Show more<\/a>/);
    const all = await html({ shown: '100' });
    expect(new Set(all.match(/Member \d{3}/g)).size).toBe(60);
    expect(all).not.toContain('Show more');
  });

  it.each(['viewer', 'assessor', 'reviewer'])('FR-MEM-02 (M10): a %s is not given the pending invitations, and their addresses are not in the page', async (role) => {
    state.role = role;
    const page = await html({});
    expect(listInvitations).not.toHaveBeenCalled();
    expect(page).not.toContain(MARKER_EMAIL);
    expect(page).not.toContain('Pending invitations');
  });

  it.each(['owner', 'admin'])('FR-MEM-02 (M10): an %s is given the pending invitations', async (role) => {
    state.role = role;
    const page = await html({});
    expect(listInvitations).toHaveBeenCalledTimes(1);
    expect(page).toContain(MARKER_EMAIL);
  });

  it('UX-37: the S-22 page and its manager import no next/link', () => {
    for (const f of ['app/(authenticated)/orgs/[slug]/settings/members/page.tsx', 'app/(authenticated)/orgs/[slug]/settings/members/MembersManager.tsx'])
      expect(readFileSync(f, 'utf8')).not.toMatch(/from 'next\/link'/);
  });
});
