import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const nav = vi.hoisted(() => ({ redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }) }));
vi.mock('next/navigation', () => ({ redirect: nav.redirect, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

type Who = { userId: string; email: string; name: string | null; platformRole: 'admin' | 'assessor'; mustChangePassword: boolean };
const identity = vi.hoisted(() => ({ current: null as unknown as Who }));
const data = vi.hoisted(() => ({ memberships: vi.fn(), findUser: vi.fn(), roleLabel: vi.fn() }));
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: async () => identity.current }));
vi.mock('@/lib/data/preauth', () => ({ membershipsForUser: data.memberships }));
vi.mock('@/lib/data/identity', () => ({ identityDb: { user: { findUnique: data.findUser } } }));
vi.mock('@/lib/authz/roleLabel', () => ({ orgRoleLabel: data.roleLabel }));

import { OrgChooser } from '@/components/org/OrgChooser';
import { ORG_COPY } from '@/lib/org/copy';
import { textOf } from '@/__tests__/helpers/markup';

/**
 * Plan 1B Task 8 (ruling L5-17): S-07, the organisation chooser, in the gate frame. A list of item plates, one per
 * organisation the person is an active member of, each linking to that organisation's Home and saying the person's role
 * there; none, the kit's empty state. T8.1 to T8.4 hold: the administrator is sent on first, the list is the person's own
 * memberships, the role comes from orgRoleLabel, and the last-organisation hint is resolveOrgDispatch's.
 */

const hrefs = (html: string) => [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]);
const ME: Who = { userId: 'u1', email: 'a@example.invalid', name: 'Amina Namusoke', platformRole: 'assessor', mustChangePassword: false };

describe('OrgChooser', () => {
  const html = renderToStaticMarkup(<OrgChooser orgs={[
    { slug: 'alpha', name: 'Alpha Lab', roleLabel: 'an Owner' },
    { slug: 'beta', name: 'Beta & Co', roleLabel: 'a Viewer' },
  ]} />);

  it('two organisations render two plates in a labelled list, each linking to its Home', () => {
    expect(html).toMatch(new RegExp(`^<ul class="org-chooser" role="list" aria-label="${ORG_COPY.chooser.listLabel}">`));
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html.match(/class="ui-plate ui-plate--link"/g)).toHaveLength(2);
    expect(hrefs(html)).toEqual(['/orgs/alpha/dashboard', '/orgs/beta/dashboard']);
  });

  it('each plate names the organisation and says the person\'s role there', () => {
    expect(textOf(html)).toContain('Alpha Lab');
    expect(textOf(html)).toContain('Beta & Co');
    expect(textOf(html)).toContain(ORG_COPY.chooser.youAre('an Owner'));
    expect(textOf(html)).toContain(ORG_COPY.chooser.youAre('a Viewer'));
    expect(ORG_COPY.chooser.youAre('an Owner')).toBe('You are an Owner');
  });

  it('spells organisation with an s (audit A 3)', () => {
    expect(html).not.toMatch(/organization/i);
  });
});

describe('S-07, the page', () => {
  type FrameProps = { route?: unknown; wide?: boolean; children: ReactElement };
  const render = async () => {
    const Page = (await import('@/app/(gate)/page')).default;
    return (await Page()) as ReactElement<FrameProps>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    identity.current = ME;
    data.findUser.mockResolvedValue({ lastActiveOrgId: null });
  });

  it('T8.2 T8.3: the list is the person\'s own memberships, each role read by orgRoleLabel(identity, slug)', async () => {
    data.memberships.mockResolvedValue([
      { orgId: 'o1', role: 'owner', org: { slug: 'alpha', name: 'Alpha Lab' } },
      { orgId: 'o2', role: 'viewer', org: { slug: 'beta', name: 'Beta Lab' } },
    ]);
    data.roleLabel.mockImplementation(async (_who: Who, slug: string) => (slug === 'alpha' ? 'owner' : 'viewer'));
    const html = renderToStaticMarkup(await render());
    expect(data.memberships.mock.calls).toEqual([['u1']]);
    expect(data.roleLabel.mock.calls).toEqual([[ME, 'alpha'], [ME, 'beta']]);
    expect(hrefs(html)).toEqual(expect.arrayContaining(['/orgs/alpha/dashboard', '/orgs/beta/dashboard']));
    expect(textOf(html)).toContain('You are an Owner');
    expect(textOf(html)).toContain('You are a Viewer');
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain(`<h1>${ORG_COPY.chooser.heading}</h1>`);
  });

  it('T8.2: an organisation whose role can no longer be read (the membership ended meanwhile) is not listed', async () => {
    data.memberships.mockResolvedValue([
      { orgId: 'o1', role: 'owner', org: { slug: 'alpha', name: 'Alpha Lab' } },
      { orgId: 'o2', role: 'viewer', org: { slug: 'beta', name: 'Beta Lab' } },
    ]);
    data.roleLabel.mockImplementation(async (_who: Who, slug: string) => (slug === 'alpha' ? 'owner' : null));
    const html = renderToStaticMarkup(await render());
    expect(hrefs(html).filter((h) => h.startsWith('/orgs/'))).toEqual(['/orgs/alpha/dashboard']);
  });

  it('a role read as text outside the five roles is an error, never the empty state (it would tell a member they are in no organisation)', async () => {
    data.memberships.mockResolvedValue([{ orgId: 'o1', role: 'owner', org: { slug: 'alpha', name: 'Alpha Lab' } }]);
    for (const label of ['Owner', 'MAK-AI administrator', 'toString']) {
      data.roleLabel.mockResolvedValue(label);
      await expect(render(), label).rejects.toThrow(/role/);
    }
  });

  it('a database error while reading a role propagates (the error page), never the empty state or a part of the list', async () => {
    data.memberships.mockResolvedValue([{ orgId: 'o1', role: 'owner', org: { slug: 'alpha', name: 'Alpha Lab' } }]);
    data.roleLabel.mockRejectedValue(new Error('connection refused'));
    await expect(render()).rejects.toThrow('connection refused');
  });

  it('none renders the kit\'s empty state under the welcome heading, with no route and no organisation link', async () => {
    data.memberships.mockResolvedValue([]);
    const el = await render();
    expect(el.props.route).toBeUndefined();
    const html = renderToStaticMarkup(el);
    expect(html).toContain(`<h1>${ORG_COPY.chooser.emptyHeading}</h1>`);
    expect(html).toMatch(/class="ui-empty"/);
    expect(textOf(html)).toContain(ORG_COPY.chooser.emptyBody);
    expect(hrefs(html).filter((h) => h.startsWith('/orgs/'))).toEqual([]);
    expect(html).not.toMatch(/organization/i);
  });

  it('T8.1: the MAK-AI administrator is sent to /admin/organisations first, before any membership or role is read', async () => {
    identity.current = { ...ME, platformRole: 'admin' };
    await expect(render()).rejects.toThrow('REDIRECT /admin/organisations');
    expect(data.memberships).not.toHaveBeenCalled();
    expect(data.roleLabel).not.toHaveBeenCalled();
  });

  it('T8.4: a last organisation that is one of the person\'s memberships redirects to its Home; one that is not, does not', async () => {
    data.memberships.mockResolvedValue([{ orgId: 'o1', role: 'owner', org: { slug: 'alpha', name: 'Alpha Lab' } }]);
    data.findUser.mockResolvedValue({ lastActiveOrgId: 'o1' });
    await expect(render()).rejects.toThrow('REDIRECT /orgs/alpha/dashboard');
    data.findUser.mockResolvedValue({ lastActiveOrgId: 'o-removed' });
    data.roleLabel.mockResolvedValue('owner');
    expect(hrefs(renderToStaticMarkup(await render()))).toContain('/orgs/alpha/dashboard');
  });
});
