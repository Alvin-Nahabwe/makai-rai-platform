import { describe, expect, it } from 'vitest';
import { LAST_PROJECT_KEY, LAST_PROJECT_PREFIX, findingsHref, railItems, roleUnderName } from '@/lib/shell/nav';
import { SHELL_COPY } from '@/lib/shell/copy';

/**
 * Plan 1A Task 11 (rulings L2-49, L2-50): the rail's items, which one is current, the Findings address and the role under the
 * person's name, as pure functions of the address and the person's own data (lib/shell/nav.ts). The markup is
 * __tests__/unit/ui/shell.test.tsx's.
 */

const member = (pathname: string) => railItems({ pathname, isPlatformAdmin: false, hasOrganisation: true, findingsHref: findingsHref('a', null) });
const keys = (items: ReturnType<typeof railItems>) => items.map((i) => `${i.group}:${i.key}`);
const current = (items: ReturnType<typeof railItems>) => items.filter((i) => i.current).map((i) => i.key);
const UUID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';

describe('railItems', () => {
  it('1A Task 12 L2-48: a member of an organisation gets Home, Projects, Findings, Guidance, Help, then Members, Organisation details, My account', () => {
    const items = member('/orgs/a/dashboard');
    expect(keys(items)).toEqual(['main:home', 'main:projects', 'main:findings', 'main:guidance', 'main:help', 'lower:members', 'lower:organisation', 'lower:account']);
    expect(items.map((i) => i.label)).toEqual(['Home', 'Projects', 'Findings', 'Guidance', 'Help', 'Members', 'Organisation details', 'My account']);
    expect(items.map((i) => i.href)).toEqual([
      '/orgs/a/dashboard', '/orgs/a/projects', '/orgs/a/projects?for=findings', '/explore/framework', '/help',
      '/orgs/a/settings/members', '/orgs/a/settings/organisation', '/account',
    ]);
    expect(items.map((i) => i.icon)).toEqual(['home', 'folder', 'flag', 'book-open', 'circle-help', 'users', 'building-2', 'user']);
  });

  it('1A Task 11 L2-49: the MAK-AI administrator gets Organisations and Accounts, then My account, and no organisation item', () => {
    const items = railItems({ pathname: '/admin/organisations', isPlatformAdmin: true, hasOrganisation: false, findingsHref: '/' });
    expect(keys(items)).toEqual(['main:admin-organisations', 'main:admin-accounts', 'lower:account']);
    expect(items.map((i) => [i.label, i.href, i.icon])).toEqual([
      ['Organisations', '/admin/organisations', 'building-2'], ['Accounts', '/admin/accounts', 'users'], ['My account', '/account', 'user'],
    ]);
    // The administrator's list does not change if the account is also in an organisation.
    expect(keys(railItems({ pathname: '/admin/accounts', isPlatformAdmin: true, hasOrganisation: true, findingsHref: '/' }))).toEqual(keys(items));
  });

  it('1A Task 12 answer (iv): the administrator\'s rail has no Help item, and on /help none of its items is current', () => {
    const items = railItems({ pathname: '/help', isPlatformAdmin: true, hasOrganisation: false, findingsHref: '/' });
    expect(items.map((i) => i.key)).not.toContain('help');
    expect(current(items)).toEqual([]);
  });

  it('1A Task 12 L2-48 (SRS 7.1.1): an account in no organisation sees only Guidance, Help and My account', () => {
    const items = railItems({ pathname: '/explore/framework', isPlatformAdmin: false, hasOrganisation: false, findingsHref: '/' });
    expect(keys(items)).toEqual(['main:guidance', 'main:help', 'lower:account']);
  });

  it('1A Task 11 L2-49: every label is the one SHELL_COPY.items holds for its key', () => {
    const all = [
      ...member('/orgs/a/dashboard'),
      ...railItems({ pathname: '/admin/organisations', isPlatformAdmin: true, hasOrganisation: false, findingsHref: '/' }),
    ];
    for (const item of all) expect(item.label, item.key).toBe(SHELL_COPY.items[item.key]);
    expect(SHELL_COPY.items).toEqual({
      home: 'Home', projects: 'Projects', findings: 'Findings', guidance: 'Guidance', help: 'Help', members: 'Members',
      organisation: 'Organisation details', account: 'My account', 'admin-organisations': 'Organisations', 'admin-accounts': 'Accounts',
    });
  });

  it('1A Task 11 L2-49: exactly one item is current, chosen by the address', () => {
    expect(current(member('/orgs/a/dashboard'))).toEqual(['home']);
    expect(current(member(`/orgs/a/projects/${UUID}`))).toEqual(['projects']);
    expect(current(member(`/orgs/a/projects/${UUID}/stages/1`))).toEqual(['projects']);
    expect(current(member(`/orgs/a/projects/${UUID}/findings`))).toEqual(['findings']);
    expect(current(member(`/orgs/a/projects/${UUID}/findings/x`))).toEqual(['findings']);
    expect(current(member('/explore/controls'))).toEqual(['guidance']);
    expect(current(member('/explore/framework'))).toEqual(['guidance']);
    expect(current(member('/orgs/a/settings/members'))).toEqual(['members']);
    expect(current(member('/orgs/a/settings/organisation'))).toEqual(['organisation']);
    expect(current(member('/account'))).toEqual(['account']);
    expect(current(member('/help'))).toEqual(['help']);
    expect(current(railItems({ pathname: '/help', isPlatformAdmin: false, hasOrganisation: false, findingsHref: '/' }))).toEqual(['help']);
    expect(current(railItems({ pathname: '/admin/accounts', isPlatformAdmin: true, hasOrganisation: false, findingsHref: '/' }))).toEqual(['admin-accounts']);
  });

  it('1A Task 11 L2-49: outside an organisation the organisation items fall back to / and none of them is current', () => {
    const items = railItems({ pathname: '/explore/framework', isPlatformAdmin: false, hasOrganisation: true, findingsHref: '/' });
    for (const key of ['home', 'projects', 'findings', 'members', 'organisation']) {
      const item = items.find((i) => i.key === key)!;
      expect(item.href, key).toBe('/');
      expect(item.current, key).toBe(false);
    }
    expect(current(railItems({ pathname: '/change-password', isPlatformAdmin: false, hasOrganisation: true, findingsHref: '/' }))).toEqual([]);
  });
});

describe('findingsHref', () => {
  it('1A Task 11 L2-49: the Findings address carries the last project only when it is a UUID', () => {
    expect(findingsHref('a', null)).toBe('/orgs/a/projects?for=findings');
    expect(findingsHref('a', UUID)).toBe(`/orgs/a/projects?for=findings&last=${UUID}`);
    expect(findingsHref('a', UUID.toUpperCase())).toBe(`/orgs/a/projects?for=findings&last=${UUID.toUpperCase()}`);
    expect(findingsHref('a', 'not-a-uuid')).toBe('/orgs/a/projects?for=findings');
    expect(findingsHref('a', `${UUID}&x=1`)).toBe('/orgs/a/projects?for=findings');
    expect(findingsHref('a', `x${UUID}`)).toBe('/orgs/a/projects?for=findings');
    expect(findingsHref('a', '')).toBe('/orgs/a/projects?for=findings');
  });

  it('1A Task 11 L2-49: the stored-project key is per person and per organisation', () => {
    expect(LAST_PROJECT_PREFIX).toBe('makrai:last-project:');
    expect(LAST_PROJECT_KEY('u1', 'a')).toBe('makrai:last-project:u1:a');
  });
});

describe('roleUnderName (ported from the sidebar, UX-02)', () => {
  const labels = { a: 'Viewer', b: 'Owner' };

  it("UX-02: inside an organisation it is the person's role there; outside one, the platform label", () => {
    expect(roleUnderName('/orgs/a/dashboard', labels, null)).toBe('Viewer');
    expect(roleUnderName('/orgs/b/projects', labels, null)).toBe('Owner');
    expect(roleUnderName('/explore/framework', labels, null)).toBeNull();
    expect(roleUnderName('/admin/users', {}, 'MAK-AI administrator')).toBe('MAK-AI administrator');
    expect(roleUnderName('/explore/framework', {}, 'MAK-AI administrator')).toBe('MAK-AI administrator');
  });

  it('UX-02 (S-31): an organisation the person is not in gives no role, even for the administrator', () => {
    expect(roleUnderName('/orgs/zzz/dashboard', labels, null)).toBeNull();
    expect(roleUnderName('/orgs/zzz/dashboard', labels, 'MAK-AI administrator')).toBeNull();
  });

  it('UX-02 NFR-SEC-07: a slug that is an Object.prototype name gives no role and does not throw', () => {
    for (const slug of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(roleUnderName(`/orgs/${slug}/dashboard`, labels, null), slug).toBeNull();
    }
  });

  it('UX-02: a label that is not a string gives no role', () => {
    const odd = { a: 7 } as unknown as Record<string, string>;
    expect(roleUnderName('/orgs/a/dashboard', odd, null)).toBeNull();
  });
});
