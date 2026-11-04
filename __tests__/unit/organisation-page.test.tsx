import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ALL_ORG_ROLES } from '@/lib/authz/roles';

/**
 * S-30 (MEM Task 2): the page's wiring. The slot components are mocked, so this proves what the page gives them
 * and to whom, not ORG's or EXP's rendering.
 */
const ORG_NAME = 'Fixture Organisation';
const slotProps: Record<string, unknown[]> = {};
let role = 'owner';

vi.mock('@/lib/auth/identity', () => ({ requireIdentity: async () => ({ userId: 'u-001' }) }));
vi.mock('@/lib/auth/context', () => ({ requireOrgContextFor: async () => ({ orgId: 'o-1', role }) }));
vi.mock('@/lib/data/tenant', () => ({
  withOrg: async (_ctx: unknown, f: (tx: unknown) => unknown) => f({ organization: { findUniqueOrThrow: async () => ({ name: ORG_NAME }) } }),
}));
vi.mock('@/lib/data/agreements', () => ({ currentAgreement: async () => null }));
vi.mock('@/lib/data/orgEvents', () => ({ listOrganisationEvents: async () => ({ events: [], hasMore: false }) }));
vi.mock('@/components/org/AgreementSummary', () => ({
  AgreementSummary: (p: unknown) => { (slotProps.AgreementSummary ??= []).push(p); return <div data-slot="agreement" />; },
}));
vi.mock('@/components/org/OrganisationEventsList', () => ({
  OrganisationEventsList: (p: unknown) => { (slotProps.OrganisationEventsList ??= []).push(p); return <div data-slot="organisation-events" />; },
}));
vi.mock('@/components/org/TeamExportLink', () => ({
  TeamExportLink: (p: unknown) => { (slotProps.TeamExportLink ??= []).push(p); return <div data-slot="team-export" />; },
}));

const { default: OrganisationPage } = await import('@/app/(authenticated)/orgs/[slug]/settings/organisation/page');

async function renderPage(r: string, searchParams: { before?: string } = {}): Promise<string> {
  role = r;
  return renderToStaticMarkup(await OrganisationPage({ params: Promise.resolve({ slug: 'acme' }), searchParams: Promise.resolve(searchParams) }));
}

beforeEach(() => { for (const k of Object.keys(slotProps)) delete slotProps[k]; });

describe('S-30 organisation details page', () => {
  it('S-30 FR-ORG-09 (helper): every member reads the details; only owners and admins see the action rows and the export link', async () => {
    for (const r of ALL_ORG_ROLES) {
      for (const k of Object.keys(slotProps)) delete slotProps[k];
      const html = await renderPage(r);
      const manager = r === 'owner' || r === 'admin';
      expect(html).toContain(ORG_NAME);
      expect(html.includes('data-slot="agreement"')).toBe(true);
      expect(html.includes('data-slot="organisation-events"')).toBe(manager);
      expect((slotProps.TeamExportLink?.[0] as { canExport: boolean; orgSlug: string }).canExport).toBe(manager);
      expect((slotProps.TeamExportLink?.[0] as { orgSlug: string }).orgSlug).toBe('acme');
    }
  });
});
