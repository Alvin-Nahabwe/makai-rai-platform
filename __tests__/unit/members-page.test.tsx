import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MemberView } from '@/types/api';

/** S-22's page: it pages what the service returns (UX-40, UX-37). The mocks stand in for the gate and the service, which other tests prove. */
const memberViews = (n: number): MemberView[] => Array.from({ length: n }, (_, i) => ({
  userId: `u-${i + 1}`, name: `Member ${String(i + 1).padStart(3, '0')}`, role: 'assessor', joinedAt: '2026-10-01T00:00:00.000Z', createdFromShownLink: false,
}));
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: async () => ({ userId: 'u-001' }) }));
vi.mock('@/lib/auth/context', () => ({ requireOrgContextFor: async () => ({ orgId: 'o-1', role: 'owner' }) }));
vi.mock('@/lib/data/members', () => ({ listMembers: async () => memberViews(60), listInvitations: async () => [] }));

const { default: MembersSettingsPage } = await import('@/app/(authenticated)/orgs/[slug]/settings/members/page');
const html = async (searchParams: { shown?: string }) =>
  renderToStaticMarkup(await MembersSettingsPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve(searchParams) }));

describe('S-22 page', () => {
  it('UX-40 UX-37 FR-MEM-02: S-22 shows 50 members and a "Show more" link to ?shown=100, then all 60 and no link', async () => {
    const first = await html({});
    expect(new Set(first.match(/Member \d{3}/g)).size).toBe(50);
    expect(first).toMatch(/<a [^>]*href="\?shown=100"[^>]*>Show more<\/a>/);
    const all = await html({ shown: '100' });
    expect(new Set(all.match(/Member \d{3}/g)).size).toBe(60);
    expect(all).not.toContain('Show more');
  });

  it('UX-37: the S-22 page and its manager import no next/link', () => {
    for (const f of ['app/(authenticated)/orgs/[slug]/settings/members/page.tsx', 'app/(authenticated)/orgs/[slug]/settings/members/MembersManager.tsx'])
      expect(readFileSync(f, 'utf8')).not.toMatch(/from 'next\/link'/);
  });
});
