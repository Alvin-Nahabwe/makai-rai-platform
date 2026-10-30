import { beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

const pathnameMock = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ usePathname: () => pathnameMock() }));
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

import Sidebar, { type SidebarProps } from '@/components/layout/Sidebar';
import { SignOutWithDraftsGuard } from '@/components/decision/SignOutWithDraftsGuard';
import { NewerLegalTextNotice } from '@/components/legal/NewerLegalTextNotice';

/**
 * UX-02: under the person's name the sidebar shows their role in the organisation whose page is open,
 * or "MAK-AI administrator", and never the account's platform role field (SRS 7.1.1, line 1523). The
 * sidebar takes only labels the layout got from `orgRoleLabel`; until AUTHZ fills that function the
 * stub returns null and nothing is shown. UX-41: no emoji, icons hidden from assistive technology.
 */

const props: SidebarProps = {
  userName: 'A',
  userId: 'u1',
  roleLabels: { a: 'viewer', b: 'owner' },
  platformLabel: null,
  orgCount: 2,
};

function renderAt(pathname: string, p: SidebarProps): string {
  pathnameMock.mockReturnValue(pathname);
  return renderToStaticMarkup(<Sidebar {...p} />);
}
const stripTags = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
function textAt(pathname: string, p: SidebarProps): string {
  return stripTags(renderAt(pathname, p));
}
function linkLabels(pathname: string, p: SidebarProps): string[] {
  return [...renderAt(pathname, p).matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((m) => stripTags(m[1]));
}
function roleText(pathname: string, p: SidebarProps): string | null {
  const m = /<span class="sidebar-user-role">([\s\S]*?)<\/span>/.exec(renderAt(pathname, p));
  return m ? stripTags(m[1]) : null;
}

describe('Sidebar role under the name', () => {
  beforeEach(() => pathnameMock.mockReset());

  it("UX-02: the sidebar shows the open organisation's role and never the platform role field", () => {
    expect(roleText('/orgs/a/dashboard', props)).toBe('viewer');
    expect(roleText('/orgs/b/projects', props)).toBe('owner');
    expect(textAt('/explore/framework', props)).not.toMatch(/assessor|viewer|owner/);
    // The old prop is gone: the component cannot be handed the account's platform role field.
    const source = readFileSync('components/layout/Sidebar.tsx', 'utf8');
    expect(source).not.toMatch(/userRole|platformRole/);
  });

  it('UX-02: with the stub label (null) the sidebar shows no role at all', () => {
    const stubbed: SidebarProps = { ...props, roleLabels: {}, platformLabel: null };
    for (const path of ['/orgs/a/dashboard', '/explore/framework', '/account']) {
      expect(renderAt(path, stubbed), path).not.toContain('sidebar-user-role');
    }
  });

  it('UX-02 (S-31): on an address for an organisation the person is not in, the sidebar shows no role', () => {
    // The signed-in group's not-found page is drawn inside this sidebar for a refused address, and
    // roleLabels only holds the person's own organisations.
    const html = textAt('/orgs/zzz/dashboard', props);
    expect(html).not.toMatch(/viewer|owner/);
    expect(renderAt('/orgs/zzz/dashboard', props)).not.toContain('sidebar-user-role');
  });

  it('UX-02 NFR-SEC-07: a slug that is an Object.prototype name reads as no role and does not throw', () => {
    // The slug is the visitor's own path segment. A plain lookup would return Object.prototype for
    // __proto__, which React refuses to render, turning S-31 into an error page for that address.
    for (const slug of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const html = renderAt(`/orgs/${slug}/dashboard`, props);
      expect(html, slug).not.toContain('sidebar-user-role');
      expect(stripTags(html), slug).not.toMatch(/\[object|function|viewer|owner/);
    }
  });

  it('UX-02: a role label is rendered as text, not markup', () => {
    const hostile: SidebarProps = { ...props, roleLabels: { a: '<img src=x onerror=alert(1)>' } };
    const html = renderAt('/orgs/a/dashboard', hostile);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('UX-02: outside an organisation the MAK-AI administrator label is shown under the name', () => {
    const admin: SidebarProps = { ...props, roleLabels: {}, platformLabel: 'MAK-AI administrator', orgCount: 0 };
    expect(roleText('/admin/users', admin)).toBe('MAK-AI administrator');
    expect(roleText('/explore/framework', admin)).toBe('MAK-AI administrator');
  });
});

describe('Sidebar items', () => {
  beforeEach(() => pathnameMock.mockReset());

  it('UX-41 (D-9): no emoji, and every icon is hidden from assistive technology', () => {
    for (const p of [props, { ...props, roleLabels: {}, platformLabel: 'MAK-AI administrator', orgCount: 0 }]) {
      const html = renderAt('/orgs/a/dashboard', p);
      expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
      for (const m of html.matchAll(/<(svg|span class="sidebar-icon")[^>]*>/g)) expect(m[0]).toContain('aria-hidden="true"');
    }
  });

  it('UX-02: the organisation shell lists the 7.1.1 items in order, Switch organisation only for more than one', () => {
    expect(linkLabels('/orgs/a/dashboard', props)).toEqual([
      'Switch organisation', 'Dashboard', 'Projects', 'Members', 'Organisation', 'Framework', 'Controls', 'About', 'My account',
    ]);
    expect(linkLabels('/orgs/a/dashboard', { ...props, orgCount: 1 })).not.toContain('Switch organisation');
    expect(linkLabels('/orgs/a/dashboard', { ...props, orgCount: 1 })).toEqual([
      'Dashboard', 'Projects', 'Members', 'Organisation', 'Framework', 'Controls', 'About', 'My account',
    ]);
  });

  it('UX-02: the organisation items and the Explore items point at the 7.1.5 addresses', () => {
    const html = renderAt('/orgs/a/dashboard', props);
    const hrefOf = (label: string) => new RegExp(`<a [^>]*href="([^"]*)"[^>]*>(?:(?!</a>)[\\s\\S])*${label}</a>`).exec(html)?.[1];
    expect(hrefOf('Dashboard')).toBe('/orgs/a/dashboard');
    expect(hrefOf('Projects')).toBe('/orgs/a/projects');
    expect(hrefOf('Members')).toBe('/orgs/a/settings/members');
    expect(hrefOf('Organisation')).toBe('/orgs/a/settings/organisation');
    expect(hrefOf('Framework')).toBe('/explore/framework');
    expect(hrefOf('Controls')).toBe('/explore/controls');
    expect(hrefOf('About')).toBe('/about');
    expect(hrefOf('My account')).toBe('/account');
    expect(hrefOf('Switch organisation')).toBe('/');
  });

  it('UX-02: the MAK-AI administrator shell has no organisation items and reads "MAK-AI administrator"', () => {
    const admin: SidebarProps = { ...props, roleLabels: {}, platformLabel: 'MAK-AI administrator', orgCount: 0 };
    const labels = linkLabels('/admin/users', admin);
    for (const l of ['Switch organisation', 'Dashboard', 'Projects', 'Members', 'Organisation']) expect(labels).not.toContain(l);
    expect(labels.slice(-4)).toEqual(['Framework', 'Controls', 'About', 'My account']);
    expect(textAt('/admin/users', admin)).toContain('MAK-AI administrator');
    // the administrator links themselves are ORG's (it renames them to Organisations and Accounts); this test does not pin them
  });

  it('UX-02: an account in no organisation sees only Explore and My account (SRS 7.1.1)', () => {
    const none: SidebarProps = { ...props, roleLabels: {}, platformLabel: null, orgCount: 0 };
    expect(linkLabels('/explore/framework', none)).toEqual(['Framework', 'Controls', 'About', 'My account']);
  });

  it('UX-02: the sidebar says "Switch organisation" in British spelling', () => {
    expect(textAt('/orgs/a/dashboard', props)).not.toMatch(/organization/i);
  });
});

describe('Sidebar slots', () => {
  it('M-41 UX-26: the Sign out button sits inside the SignOutWithDraftsGuard slot', () => {
    const source = readFileSync('components/layout/Sidebar.tsx', 'utf8');
    expect(source).toMatch(/<SignOutWithDraftsGuard userId=\{userId\}>[\s\S]*?Sign out[\s\S]*?<\/SignOutWithDraftsGuard>/);
    pathnameMock.mockReturnValue('/orgs/a/dashboard');
    expect(renderToStaticMarkup(<Sidebar {...props} />)).toContain('Sign out');
  });

  it('M-41: the stub guard renders its children unchanged', () => {
    expect(renderToStaticMarkup(<SignOutWithDraftsGuard userId="u1"><button>Sign out</button></SignOutWithDraftsGuard>)).toBe('<button>Sign out</button>');
  });

  it('M-39: the stub notice renders nothing until ACC-a fills it', async () => {
    expect(await NewerLegalTextNotice({ userId: 'u1' })).toBeNull();
  });

  it('M-39 M-41: both slot stubs carry their producer marker', () => {
    expect(readFileSync('components/legal/NewerLegalTextNotice.tsx', 'utf8')).toMatch(/\/\/ SLOT_STUB: ACC-a\nexport async function NewerLegalTextNotice/);
    expect(readFileSync('components/decision/SignOutWithDraftsGuard.tsx', 'utf8')).toMatch(/\/\/ SLOT_STUB: DEC-b\nexport function SignOutWithDraftsGuard/);
  });
});
