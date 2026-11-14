import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ALL_ORG_ROLES } from '@/lib/authz/roles';
import { ORG_COPY } from '@/lib/org/copy';

/**
 * S-30 (MEM Task 2): the page's wiring (the organisation's name and legal name, and the two slots). The slot components are mocked, so this proves what the page gives them
 * and to whom, not ORG's or EXP's rendering.
 */
const ORG_NAME = 'Fixture Organisation';
const slotProps: Record<string, unknown[]> = {};
let role = 'owner';
let legalName: string | null = 'Fixture University';

vi.mock('@/lib/auth/identity', () => ({ requireIdentity: async () => ({ userId: 'u-001' }) }));
vi.mock('@/lib/auth/context', () => ({ requireOrgContextFor: async () => ({ orgId: 'o-1', role }) }));
vi.mock('@/lib/data/tenant', () => ({
  withOrg: async (_ctx: unknown, f: (tx: unknown) => unknown) => f({ organization: { findUniqueOrThrow: async () => ({ name: ORG_NAME, legalName }) } }),
}));
const listEvents = vi.hoisted(() => vi.fn(async (_ctx: unknown, _page: { before?: string; limit: number }) => ({ events: [], hasMore: false })));
vi.mock('@/lib/data/orgEvents', () => ({ listOrganisationEvents: listEvents }));
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

beforeEach(() => { for (const k of Object.keys(slotProps)) delete slotProps[k]; legalName = 'Fixture University'; });

describe('S-30 organisation details page', () => {
  it('S-30 FR-ORG-09 (helper): every member reads the details; only owners and admins see the action rows and the export link', async () => {
    for (const r of ALL_ORG_ROLES) {
      for (const k of Object.keys(slotProps)) delete slotProps[k];
      const html = await renderPage(r);
      const manager = r === 'owner' || r === 'admin';
      expect(html).toContain(ORG_NAME);
      expect(html.includes('data-slot="organisation-events"')).toBe(manager);
      // The export block renders only for a role that can export (defect 42), so the link is wired only for owners and admins.
      expect(slotProps.TeamExportLink ?? [], r).toEqual(manager ? [{ orgSlug: 'acme', canExport: true }] : []);
    }
  });

  it('S-30 (defect 42): one heading per block, no export heading for a role that cannot export, and no label pointing at nothing', async () => {
    for (const r of ALL_ORG_ROLES) {
      const html = await renderPage(r);
      const manager = r === 'owner' || r === 'admin';
      expect(html, r).not.toContain('Membership and organisation changes');   // OrganisationEventsList carries the block's one heading
      expect(html.includes(`<h2 id="export-heading">${ORG_COPY.organisation.downloadHeading}</h2>`), r).toBe(manager);
      for (const m of html.matchAll(/aria-labelledby="([^"]+)"/g)) expect(html, `${r}: ${m[1]}`).toContain(`id="${m[1]}"`);
    }
  });

  it('S-30 shows the legal name or Not recorded, and no agreement', async () => {
    for (const r of ALL_ORG_ROLES) {
      legalName = 'Fixture University';
      const html = await renderPage(r);
      expect(html, r).toContain(`<div class="ui-page-header__lead"><p>${ORG_NAME}</p>`);
      expect(html, r).toContain(ORG_COPY.organisation.legalName('Fixture University'));
      expect(html, r).not.toMatch(/agreement|controller|data-protection contact/i);
      legalName = null;
      const none = await renderPage(r);
      expect(none, r).toContain(ORG_COPY.organisation.legalName(null));
      expect(none, r).not.toMatch(/agreement/i);
    }
  });

  it('FR-ORG-09 (RE-3): ?before reaches the reader only as an id; anything else is a first page', async () => {
    const id = '3f6b1c1e-6a52-4d57-9f6a-0b7a3c1d2e45';
    listEvents.mockClear();
    await renderPage('owner', { before: id });
    await renderPage('owner', { before: "x'; not an id" });
    await renderPage('owner', { before: 'a'.repeat(500) });
    expect(listEvents.mock.calls.map((c) => c[1].before)).toEqual([id, undefined, undefined]);
  });
});
