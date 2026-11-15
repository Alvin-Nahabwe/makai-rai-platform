import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

const pathnameMock = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ usePathname: () => pathnameMock() }));
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

import AppShell from '@/components/layout/AppShell';
import Rail from '@/components/layout/Rail';
import TopBar from '@/components/layout/TopBar';
import OrgSwitcher from '@/components/layout/OrgSwitcher';
import ThemeToggle from '@/components/layout/ThemeToggle';
import PublicHeader from '@/components/layout/PublicHeader';
import type { ShellData } from '@/lib/shell/types';

/**
 * Plan 1A Task 11 (rulings L2-44, L2-47, L2-52, L2-53): the shell's markup, rendered on the server. One navigation tree, the
 * rail, inside a popover panel that the top bar's Menu button opens below 1024 px; the organisation switcher; the theme switch;
 * the public header. The UX-02 and UX-41 cases are the sidebar's (__tests__/unit/sidebar-role.test.tsx), ported to the rail.
 */

const shell: ShellData = {
  userId: 'u1',
  userName: 'A',
  platformLabel: null,
  roleLabels: { a: 'Viewer', b: 'Owner' },
  orgs: [{ slug: 'a', name: 'Alpha Lab' }, { slug: 'b', name: 'Beta Lab' }],
  homeSlug: null,
};
const admin: ShellData = { userId: 'a1', userName: 'A', platformLabel: 'MAK-AI administrator', roleLabels: {}, orgs: [], homeSlug: null };
const noOrg: ShellData = { userId: 'n1', userName: 'N', platformLabel: null, roleLabels: {}, orgs: [], homeSlug: null };

function at(pathname: string): void {
  pathnameMock.mockReturnValue(pathname);
}
/**
 * React 19 emits a <link rel="preload" as="image"> for the logo's <img> ahead of the markup (in a page, Next.js puts it in
 * <head>); these tests read the shell's own markup, so it is cut off. The logo itself: __tests__/unit/ui/shell-route.test.tsx.
 */
const withoutPreloads = (html: string) => html.replace(/^(<link rel="preload"[^>]*>)+/, '');
function rail(pathname: string, data: ShellData = shell): string {
  at(pathname);
  return withoutPreloads(renderToStaticMarkup(<Rail shell={data} />));
}
function page(pathname: string, data: ShellData = shell, children = <p>page</p>): string {
  at(pathname);
  return withoutPreloads(renderToStaticMarkup(<AppShell shell={data}>{children}</AppShell>));
}
const stripTags = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/** The rail's navigation, without its brand link (the logo and the platform's name, tested in shell-route.test.tsx). */
const navOf = (html: string) => (/<nav [^>]*>[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '').replace(/<a [^>]*class="shell-rail__brand"[^>]*>[\s\S]*?<\/a>/, '');
const linkLabels = (html: string) => [...navOf(html).matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((m) => stripTags(m[1]));
function roleText(html: string): string | null {
  const m = /<span class="shell-rail__role">([\s\S]*?)<\/span>/.exec(html);
  return m ? stripTags(m[1]) : null;
}
/** The text of the person block: the name and, when there is one, the role. */
const personText = (html: string) => stripTags(/<li class="shell-rail__person">([\s\S]*?)<\/li>/.exec(html)?.[1] ?? 'MISSING');

beforeEach(() => pathnameMock.mockReset());

describe('the one navigation tree (L2-44)', () => {
  it('1A Task 11 L2-44: the page has exactly one <nav aria-label="Main">, inside the rail, inside the panel', () => {
    const html = page('/orgs/a/dashboard');
    expect([...html.matchAll(/<nav\b/g)]).toHaveLength(1);
    expect([...html.matchAll(/<nav [^>]*aria-label="Main"/g)]).toHaveLength(1);
    const panel = /<div [^>]*id="shell-menu"[^>]*>([\s\S]*)<\/div><main/.exec(html)?.[1] ?? '';
    // L2-60: the rail's root is the landmark, so the product name, the switcher, Sign out and the theme switch are in it.
    expect(panel).toMatch(/^<nav class="shell-rail" aria-label="Main">/);
  });

  it('1A Task 11 L2-44: the Menu button reads "Menu" and opens the panel by popovertarget', () => {
    const html = page('/orgs/a/dashboard');
    const button = /<button [^>]*class="shell-topbar__menu-button"[^>]*>([\s\S]*?)<\/button>/.exec(html);
    expect(button).not.toBeNull();
    expect(stripTags(button![1])).toBe('Menu');
    // React writes the attribute as popoverTarget; HTML attribute names are case-insensitive, so the parser reads popovertarget.
    expect(button![0]).toMatch(/ popovertarget="shell-menu"/i);
    expect(button![0]).toContain('aria-controls="shell-menu"');
    // L2-44 amended: no state in the server markup; the mount sync and every toggle set it.
    expect(button![0]).not.toContain('aria-expanded');
    expect(button![0]).toContain('type="button"');
    expect(html).toMatch(/<div [^>]*id="shell-menu"[^>]*popover="auto"|<div [^>]*popover="auto"[^>]*id="shell-menu"/);
    expect(html).toMatch(/<div [^>]*class="shell-topbar__panel"/);
    // Route task 1: the Menu button first, then the MAK-AI logo linking Home, named "MAK-AI RAI Platform".
    expect(html).toMatch(/<header class="shell-topbar"><button [^>]*class="shell-topbar__menu-button"/);
    expect(html).toMatch(/<a class="shell-topbar__brand" href="\/orgs\/a\/dashboard"><img [^>]*alt="MAK-AI RAI Platform"/);
  });

  it('1A Task 11 L2-44: AppShell puts its children first inside <main id="main-content" tabindex="-1" class="shell__main">, and nothing of the shell is in main', () => {
    const html = page('/orgs/a/dashboard', shell, <p>the page itself</p>);
    expect(html).toMatch(/^<div class="shell">/);
    const main = /<main [^>]*>([\s\S]*)<\/main>/.exec(html);
    expect(main).not.toBeNull();
    expect(main![0]).toMatch(/^<main id="main-content" tabindex="-1" class="shell__main">/);
    expect(main![1]).toBe('<p>the page itself</p>');
    for (const cls of ['shell-topbar', 'shell-rail', 'shell-org', 'shell-theme']) expect(main![1]).not.toContain(cls);
    // The top bar and the panel come before main.
    expect(html.indexOf('shell-topbar')).toBeLessThan(html.indexOf('<main'));
    expect(html.indexOf('id="shell-menu"')).toBeLessThan(html.indexOf('<main'));
  });

  it('1A Task 11 L2-52: the current item has aria-current="page" and the orange fill class; no other item has either', () => {
    const html = rail('/orgs/a/dashboard');
    const links = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    const currentLinks = links.filter((l) => l.includes('aria-current="page"'));
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]).toContain('href="/orgs/a/dashboard"');
    expect(currentLinks[0]).toContain('class="shell-rail__item shell-rail__item--current"');
    expect(links.filter((l) => l.includes('shell-rail__item--current'))).toHaveLength(1);
    for (const l of links.filter((x) => x.includes('shell-rail__item') && !x.includes('aria-current'))) expect(l).toContain('class="shell-rail__item"');
  });

  it('1A Task 11 L2-52: the rail holds the brand (the logo and the product name), the switcher, the navigation, Sign out and the theme switch, in that order', () => {
    const html = rail('/orgs/a/dashboard');
    expect(html).toMatch(/^<nav class="shell-rail" aria-label="Main">/);
    expect(html).toMatch(/<\/nav>$/);
    const order = ['<span class="shell-rail__product">MAK-AI RAI Platform</span>', 'class="shell-rail__org"', '<div class="shell-rail__nav">', 'class="shell-rail__lower"', 'class="shell-rail__signout"', 'class="shell-theme'];
    const positions = order.map((s) => html.indexOf(s));
    for (const p of positions) expect(p).toBeGreaterThanOrEqual(0);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    // One image, the MAK-AI logo (route task 1), and no aside.
    expect([...html.matchAll(/<img /g)]).toHaveLength(1);
    expect(html).not.toMatch(/<aside/);
  });

  it('1A Task 11 L2-52 L2-61: no organisation, no switcher block; and none for the administrator', () => {
    expect(rail('/explore/framework', noOrg)).not.toContain('shell-rail__org');
    expect(rail('/admin/organisations', admin)).not.toContain('shell-rail__org');
    expect(rail('/admin/organisations', { ...admin, orgs: [{ slug: 'a', name: 'Alpha Lab' }] })).not.toContain('shell-org');
  });
});

describe('the rail, ported from the sidebar (UX-02, UX-41)', () => {
  it("UX-02: the rail shows the open organisation's role and never the platform role field", () => {
    expect(roleText(rail('/orgs/a/dashboard'))).toBe('Viewer');
    expect(roleText(rail('/orgs/b/projects'))).toBe('Owner');
    expect(stripTags(rail('/explore/framework'))).not.toMatch(/assessor|viewer|owner/i);
    for (const file of ['components/layout/Rail.tsx', 'components/layout/AppShell.tsx', 'lib/shell/types.ts', 'lib/shell/data.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/userRole|platformRole/);
    }
  });

  it('UX-02: with no role label the rail shows the name and no role at all', () => {
    const stubbed: ShellData = { ...shell, roleLabels: {}, platformLabel: null };
    for (const path of ['/orgs/a/dashboard', '/explore/framework', '/account']) {
      const html = rail(path, stubbed);
      // The person block holds the name and nothing after it: no role element and no role words.
      expect(personText(html), path).toBe('A');
      expect(html, path).toMatch(/<li class="shell-rail__person"><span class="shell-rail__name">A<\/span><\/li>/);
    }
  });

  it('UX-02 (S-31): on an address for an organisation the person is not in, the rail shows no role and no organisation name for it', () => {
    const html = rail('/orgs/zzz/dashboard');
    expect(personText(html)).toBe('A');
    expect(stripTags(html)).not.toMatch(/viewer|owner|zzz/i);
    // The switcher's button names no organisation: the address's slug is none of the person's.
    expect(/<button [^>]*class="shell-org__button"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1]).not.toContain('shell-org__name');
  });

  it('UX-02 NFR-SEC-07: a slug that is an Object.prototype name reads as no role and does not throw', () => {
    for (const slug of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const html = rail(`/orgs/${slug}/dashboard`);
      expect(personText(html), slug).toBe('A');
      expect(html, slug).not.toContain('shell-rail__role');
      expect(stripTags(html), slug).not.toMatch(/\[object|function|viewer|owner/i);
    }
  });

  it('UX-02 NFR-SEC-11: a role label, a person\'s name and an organisation name are rendered as text, not markup', () => {
    const hostile: ShellData = {
      ...shell, userName: '<b>x</b>', roleLabels: { a: '<img src=x onerror=alert(1)>' },
      orgs: [{ slug: 'a', name: '<img src=y onerror=alert(2)>' }],
    };
    const html = rail('/orgs/a/dashboard', hostile);
    expect(html).not.toMatch(/<img src=[xy]|<b>x/);
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain('&lt;img src=y');
    expect(html).toContain('&lt;b&gt;x');
    for (const file of ['components/layout/Rail.tsx', 'components/layout/OrgSwitcher.tsx', 'components/layout/TopBar.tsx', 'components/layout/AppShell.tsx']) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('dangerouslySetInnerHTML');
    }
  });

  it('UX-02: outside an organisation the MAK-AI administrator label is shown under the name', () => {
    expect(roleText(rail('/admin/users', admin))).toBe('MAK-AI administrator');
    expect(roleText(rail('/explore/framework', admin))).toBe('MAK-AI administrator');
  });

  it('UX-41 (D-9): no emoji, and every icon is hidden from assistive technology', () => {
    for (const data of [shell, admin, noOrg]) {
      const html = page('/orgs/a/dashboard', data);
      expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
      const svgs = [...html.matchAll(/<svg[^>]*>/g)];
      expect(svgs.length).toBeGreaterThan(0);
      for (const m of svgs) expect(m[0]).toContain('aria-hidden="true"');
    }
  });

  it('1A Task 12 L2-48 (spec 7.5): the organisation rail lists Home, Projects, Findings, Guidance, Help, Members, Organisation, My account at their addresses', () => {
    const html = rail('/orgs/a/dashboard');
    expect(linkLabels(html)).toEqual(['Home', 'Projects', 'Findings', 'Guidance', 'Help', 'Members', 'Organisation', 'My account']);
    const hrefs = [...navOf(html).matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    expect(hrefs).toEqual([
      '/orgs/a/dashboard', '/orgs/a/projects', '/orgs/a/projects?for=findings', '/explore/framework', '/help',
      '/orgs/a/settings/members', '/orgs/a/settings/organisation', '/account',
    ]);
    // Members and Organisation in the lower list; then, in the rail's pinned foot (fix round 3, review D4), the person, then
    // My account.
    const lower = /<ul class="shell-rail__lower">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
    expect(lower.indexOf('Members<')).toBeGreaterThanOrEqual(0);
    expect(lower.indexOf('Organisation<')).toBeGreaterThan(lower.indexOf('Members<'));
    const foot = /<ul class="shell-rail__account">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
    expect(foot.indexOf('shell-rail__person')).toBeGreaterThanOrEqual(0);
    expect(foot.indexOf('shell-rail__person')).toBeLessThan(foot.indexOf('My account'));
  });

  it('S4: on Help, My account and Guidance the five organisation links go to the person\'s home organisation, not to Home', () => {
    const hrefsOf = (html: string) => [...navOf(html).matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    const one: ShellData = { ...shell, roleLabels: { a: 'Viewer' }, orgs: [{ slug: 'a', name: 'Alpha Lab' }], homeSlug: 'a' };
    const twoHinted: ShellData = { ...shell, homeSlug: 'b' };
    for (const [data, s] of [[one, 'a'], [twoHinted, 'b']] as const) {
      for (const path of ['/help', '/account', '/explore/framework']) {
        expect(hrefsOf(rail(path, data)), `${path} ${s}`).toEqual([
          `/orgs/${s}/dashboard`, `/orgs/${s}/projects`, `/orgs/${s}/projects?for=findings`, '/explore/framework', '/help',
          `/orgs/${s}/settings/members`, `/orgs/${s}/settings/organisation`, '/account',
        ]);
      }
    }
  });

  it('S4: two organisations and no usable home give the chooser (/), and a home slug outside the person\'s organisations is never used', () => {
    for (const data of [shell, { ...shell, homeSlug: 'zzz' }]) {
      const html = rail('/account', data);
      const hrefs = [...navOf(html).matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]);
      expect(hrefs.slice(0, 3)).toEqual(['/', '/', '/']);
      expect(hrefs.slice(5, 7)).toEqual(['/', '/']);
      expect(html).not.toContain('zzz');
    }
  });

  it('S4: no organisation gives no organisation link, and the administrator\'s rail is unchanged, with a home slug or without', () => {
    expect(linkLabels(rail('/account', noOrg))).toEqual(['Guidance', 'Help', 'My account']);
    expect(linkLabels(rail('/account', { ...admin, homeSlug: null }))).toEqual(['Organisations', 'Accounts', 'My account']);
    // A home slug the server never sends for the administrator: the rail still draws no organisation link.
    expect(linkLabels(rail('/account', { ...admin, homeSlug: 'a' }))).toEqual(['Organisations', 'Accounts', 'My account']);
    expect(rail('/account', { ...admin, homeSlug: 'a' })).not.toContain('/orgs/');
  });

  it('UX-01 UX-02: the MAK-AI administrator rail links S-23 and S-25, then My account, and has no organisation item', () => {
    const html = rail('/admin/organisations', admin);
    expect(linkLabels(html)).toEqual(['Organisations', 'Accounts', 'My account']);
    expect(stripTags(html)).toContain('MAK-AI administrator');
  });

  it('UX-02 (SRS 7.1.1) 1A Task 12 L2-48: an account in no organisation sees only Guidance, Help and My account', () => {
    expect(linkLabels(rail('/explore/framework', noOrg))).toEqual(['Guidance', 'Help', 'My account']);
  });

  it('UX-02: the rail says "Switch organisation" in British spelling', () => {
    const text = stripTags(rail('/orgs/a/dashboard'));
    expect(text).toContain('Switch organisation');
    expect(text).not.toMatch(/organization/i);
  });

  it('M-41 UX-26: the Sign out button sits inside the SignOutWithDraftsGuard slot, with the person\'s own id', () => {
    const source = readFileSync('components/layout/Rail.tsx', 'utf8');
    expect(source).toMatch(/<SignOutWithDraftsGuard userId=\{shell\.userId\} onPhase=\{showSignOut\}>\s*<button type="button" className="shell-rail__signout"[\s\S]*?SHELL_COPY\.signOut[\s\S]*?<\/button>\s*<\/SignOutWithDraftsGuard>/);
    expect(rail('/orgs/a/dashboard')).toMatch(/<button type="button" class="shell-rail__signout">[\s\S]*?Sign out<\/button>/);
  });

  it('1A Task 12 L2-64: the shell touches no storage but the theme key and lib/client/lastProject.ts, and builds no address from a query', () => {
    for (const file of ['components/layout/Rail.tsx', 'components/layout/TopBar.tsx', 'components/layout/OrgSwitcher.tsx', 'components/layout/AppShell.tsx', 'lib/shell/nav.ts', 'lib/shell/data.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/localStorage|sessionStorage|indexedDB|useSearchParams|searchParams|document\.cookie/);
    }
    const theme = readFileSync('components/layout/ThemeToggle.tsx', 'utf8');
    expect([...theme.matchAll(/localStorage\.(\w+)\(/g)].map((m) => m[1])).toEqual(['setItem']);
    expect(theme).toContain("localStorage.setItem('theme', next)");
    // The one file under components/layout and lib/shell, besides the theme switch, that names localStorage is
    // lib/client/lastProject.ts: one getItem, one setItem and two removal loops (this person's keys at sign-out; other
    // people's keys before a write, ruling L2-75), each storage call inside a try.
    const layoutAndShell = [
      ...readdirSync('components/layout').map((f) => `components/layout/${f}`),
      ...readdirSync('lib/shell').map((f) => `lib/shell/${f}`),
    ].filter((f) => /\.(ts|tsx)$/.test(f) && f !== 'components/layout/ThemeToggle.tsx');
    for (const f of layoutAndShell) expect(readFileSync(f, 'utf8'), f).not.toMatch(/localStorage/);
    const store = readFileSync('lib/client/lastProject.ts', 'utf8');
    const calls = [...store.matchAll(/localStorage\.(\w+)\(/g)];
    expect(calls.map((m) => m[1])).toEqual(['getItem', 'setItem', 'key', 'removeItem', 'key', 'removeItem']);
    for (const m of calls) {
      const before = store.slice(0, m.index);
      expect(before.lastIndexOf('try {'), `${m[1]} at ${m.index}`).toBeGreaterThan(before.lastIndexOf('}\n'));
    }
    // The rail reads it through the store's subscription, after hydration (the server snapshot is null).
    const railSource = readFileSync('components/layout/Rail.tsx', 'utf8');
    expect(railSource).toMatch(/useSyncExternalStore\(\s*subscribeLastProject,\s*\(\) => \(slug \? readLastProject\(shell\.userId, slug\) : null\),\s*\(\) => null,?\s*\)/);
  });

  it('1A Task 12 P2: the server-rendered Findings link is the plain address, whatever the device holds', () => {
    // A device that holds a last project: a rail that read storage during the server render would put it in the address.
    const held = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
    vi.stubGlobal('localStorage', { getItem: () => held, setItem: () => {}, removeItem: () => {}, key: () => null, length: 1, clear: () => {} });
    vi.stubGlobal('window', new EventTarget());
    try {
      const hrefs = [...navOf(rail(`/orgs/a/projects/${held}`)).matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
      expect(hrefs).toContain('/orgs/a/projects?for=findings');
      expect(hrefs.some((h) => h.includes('last='))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('1A Task 12 F1b: the public header\'s product-name link to / does not prefetch; About, Sign in and the footer keep the default', () => {
    const header = readFileSync('components/layout/PublicHeader.tsx', 'utf8');
    const links = [...header.matchAll(/<Link\b[^>]*>/g)].map((m) => m[0]);
    expect(links).toHaveLength(3);
    expect(links[0]).toMatch(/href="\/"/);
    expect(links[0]).toMatch(/prefetch=\{false\}/);
    for (const l of links.slice(1)) expect(l).not.toMatch(/prefetch=/);
    expect(readFileSync('components/layout/Footer.tsx', 'utf8')).not.toMatch(/prefetch=/);
  });

  it('1A Task 12 L2-66 S4: the rail\'s Sign out clears this person\'s last-project keys before signing out', () => {
    const source = readFileSync('components/layout/Rail.tsx', 'utf8');
    // Since ruling L5-11 the sign-out goes through signOutClearingDrafts, which also sweeps the keys and navigates only
    // when the session ended; a refusal is logged by name, the person stays on the page, and the rail says they are still
    // signed in (__tests__/unit/sign-out-refused.test.tsx).
    expect(source).toMatch(/onClick=\{\(\) => \{ void signOutFromRail\(shell\.userId, showSignOut, signOutPending\); \}\}/);
    expect(source).toMatch(/clearLastProjects\(userId\);\s*try \{\s*await signOutClearingDrafts\(userId, '\/login'\);\s*\} catch/);
  });
});

describe('the public pages load no shell stylesheet (plan 1A Task 12, fix round 1, F1a)', () => {
  /** The files a module imports, resolved: `@/` and relative specifiers to .ts, .tsx or .css files that exist. */
  function importsOf(file: string): string[] {
    const src = readFileSync(file, 'utf8');
    const out: string[] = [];
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+'([^']+)'|(?:^|\n)\s*import\s+'([^']+)'/g)) {
      const spec = m[1] ?? m[2];
      if (!spec.startsWith('@/') && !spec.startsWith('.')) continue;
      const base = spec.startsWith('@/') ? spec.slice(2) : join(dirname(file), spec);
      const found = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((c) => existsSync(c) && statSync(c).isFile());
      if (found !== undefined) out.push(found.replace(/\\/g, '/'));
    }
    return out;
  }
  function closure(roots: string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const f = queue.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (/\.(ts|tsx)$/.test(f)) queue.push(...importsOf(f));
    }
    return seen;
  }

  it('F1a: nothing the root layout, the not-found page, the public layout, any public page, the footer, the public header, the theme switch or the idle warning imports reaches shell.css', () => {
    // Every page.tsx under app/(public)/ is walked from disk, so a new public page is covered without an edit.
    const publicPages = readdirSync('app/(public)', { recursive: true, encoding: 'utf8' })
      .filter((f) => f === 'page.tsx' || f.endsWith('/page.tsx')).map((f) => `app/(public)/${f}`);
    expect(publicPages.length).toBeGreaterThanOrEqual(8);
    const roots = ['app/layout.tsx', 'app/not-found.tsx', 'app/(public)/layout.tsx', ...publicPages, 'components/layout/Footer.tsx',
      'components/layout/PublicHeader.tsx', 'components/layout/ThemeToggle.tsx', 'components/layout/IdleWarning.tsx'];
    const reached = closure(roots);
    expect(reached.size).toBeGreaterThan(roots.length);
    expect([...reached].filter((f) => f.endsWith('components/layout/shell.css'))).toEqual([]);
  });

  it('F1a: the importers of shell.css and of the four signed-in shell files, across app and components, are exactly these', () => {
    const files = ['app', 'components'].flatMap((root) => readdirSync(root, { recursive: true, encoding: 'utf8' }).map((f) => `${root}/${f}`))
      .filter((f) => /\.tsx?$/.test(f));
    const importersOf = (target: string) => files.filter((f) => importsOf(f).includes(target)).sort();
    // A new importer fails here and is looked at: a public page that reached any of these would load the rail's rules.
    expect({
      shellCss: importersOf('components/layout/shell.css'),
      appShell: importersOf('components/layout/AppShell.tsx'),
      topBar: importersOf('components/layout/TopBar.tsx'),
      rail: importersOf('components/layout/Rail.tsx'),
      orgSwitcher: importersOf('components/layout/OrgSwitcher.tsx'),
    }).toEqual({
      shellCss: ['components/layout/AppShell.tsx', 'components/layout/OrgSwitcher.tsx', 'components/layout/Rail.tsx', 'components/layout/TopBar.tsx'],
      // Help's layout renders the shell only past the gates (S5); /help's signed-out first visit, with whatever its layout's
      // module graph loads, is measured by e2e/first-visit-transfer.spec.ts.
      appShell: ['app/(authenticated)/layout.tsx', 'app/help/layout.tsx'],
      topBar: ['components/layout/AppShell.tsx'],
      rail: ['components/layout/TopBar.tsx'],
      orgSwitcher: ['components/layout/Rail.tsx'],
    });
  });

  it('F1a: the public shell\'s and the idle warning\'s rules are one block at the very end of app/globals.css, and gone from shell.css', () => {
    const globals = readFileSync('app/globals.css', 'utf8');
    const start = globals.indexOf('/* Moved from components/layout/shell.css');
    expect(start).toBeGreaterThan(0);
    const block = globals.slice(start);
    const shell = readFileSync('components/layout/shell.css', 'utf8');
    for (const sel of ['.shell-public-header {', '.shell-theme--on-light {', '.shell-theme__to-light {', '.shell-idle__failed {']) {
      // at the start of a line: the top-level rule, not the print rule's indented selector list
      expect(block.split('\n'), sel).toContain(sel);
      expect(shell.split('\n'), sel).not.toContain(sel);
    }
    // The print rule is in both, byte for byte: globals.css for the public pages, and the end of shell.css for the signed-in
    // pages. shell.css used to be linked before globals.css and now follows it there, so without the copy the top bar's own
    // `display: flex` (below 1024 px) and the panel's `display: block` (from 1024 px) would beat the print rule at every width.
    // Route task 1: the footer's own rules left globals.css for its component-local sheet, which only Footer.tsx imports
    // (a public page loads it with the root layout; it never reaches shell.css, the F1a case above).
    const footer = readFileSync('components/layout/footer.css', 'utf8');
    expect(footer.split('\n')).toContain('.shell-footer {');
    expect(globals.split('\n')).not.toContain('.shell-footer {');
    expect(shell.split('\n')).not.toContain('.shell-footer {');
    const print = (css: string) => css.slice(css.lastIndexOf('/* ── Print: the page\'s content only ── */'));
    expect(print(block)).toMatch(/^\/\* ── Print[\s\S]*@media print \{[\s\S]*\.shell-footer[\s\S]*\}\n$/);
    expect(print(shell)).toBe(print(block));
  });
});

describe('the organisation switcher (L2-53)', () => {
  it('1A Task 11 L2-53: one organisation is a name, with no control', () => {
    at('/orgs/a/dashboard');
    expect(renderToStaticMarkup(<OrgSwitcher orgs={[{ slug: 'a', name: 'Alpha Lab' }]} currentSlug="a" />))
      .toBe('<div class="shell-org"><span class="shell-org__name">Alpha Lab</span></div>');
  });

  it('1A Task 11 L2-53: two organisations are a button naming the open one, and a closed, empty list', () => {
    at('/orgs/b/dashboard');
    const html = renderToStaticMarkup(<OrgSwitcher orgs={shell.orgs} currentSlug="b" />);
    const button = /<button [^>]*>([\s\S]*?)<\/button>/.exec(html);
    expect(button![0]).toContain('class="shell-org__button"');
    expect(button![0]).toContain('type="button"');
    expect(button![0]).toContain('aria-expanded="false"');
    expect(button![0]).toMatch(/aria-controls="([^"]+)"/);
    const listId = /aria-controls="([^"]+)"/.exec(button![0])![1];
    expect(button![1]).toContain('<span class="shell-org__name">Beta Lab</span>');
    expect(button![1]).toContain('<span class="shell-org__action">Switch organisation</span>');
    expect(button![1]).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toContain(`<ul id="${listId}" class="shell-org__list" hidden=""></ul>`);
    expect(html).not.toContain('<a ');
  });

  it('1A Task 11 L2-53 T3: with no organisation of the person open, the button names none', () => {
    at('/explore/framework');
    const html = renderToStaticMarkup(<OrgSwitcher orgs={shell.orgs} currentSlug={null} />);
    expect(html).not.toContain('shell-org__name');
    expect(stripTags(html)).toBe('Switch organisation');
    at('/orgs/zzz/dashboard');
    expect(stripTags(renderToStaticMarkup(<OrgSwitcher orgs={shell.orgs} currentSlug="zzz" />))).toBe('Switch organisation');
    for (const slug of ['__proto__', 'constructor', 'toString']) {
      expect(stripTags(renderToStaticMarkup(<OrgSwitcher orgs={shell.orgs} currentSlug={slug} />)), slug).toBe('Switch organisation');
    }
  });
});

describe('the theme switch (L2-47)', () => {
  it('1A Task 11 L2-47: both labels in the markup, one shown by CSS; no aria-pressed, no aria-label, no title; icons hidden', () => {
    for (const onLight of [false, true]) {
      const html = renderToStaticMarkup(<ThemeToggle onLight={onLight} />);
      expect(html).toMatch(new RegExp(`^<button type="button" class="${onLight ? 'shell-theme shell-theme--on-light' : 'shell-theme'}">`));
      // The words in their own span (fix round 4: the rail shows the switch as an icon and keeps the words as its name).
      expect(html).toMatch(/<span class="shell-theme__to-dark"><svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><span class="shell-theme__label">Switch to dark theme<\/span><\/span>/);
      expect(html).toMatch(/<span class="shell-theme__to-light"><svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><span class="shell-theme__label">Switch to light theme<\/span><\/span>/);
      expect(html).not.toMatch(/aria-pressed|aria-label|title=/);
      expect(html).not.toMatch(/\p{Extended_Pictographic}|◐/u);
      for (const m of html.matchAll(/<svg[^>]*>/g)) expect(m[0]).toContain('aria-hidden="true"');
    }
  });

  it('1A Task 11 L2-47: the switch keeps no state, so the server and the first client render are the same', () => {
    const source = readFileSync('components/layout/ThemeToggle.tsx', 'utf8');
    expect(source).not.toMatch(/useState|useEffect/);
  });
});

describe('the public header (L2-55)', () => {
  it('UX-03 1A Task 11: the public header holds the product name linking home, About, Sign in and the theme switch, in a navigation named Site', () => {
    const html = renderToStaticMarkup(<PublicHeader />);
    expect(html).toMatch(/^<header class="shell-public-header">/);
    expect(html).toMatch(/<a class="shell-public-header__name" href="\/">MAK-AI RAI Platform<\/a>/);
    expect(html).toMatch(/<nav aria-label="Site" class="shell-public-header__nav">/);
    expect(html).toMatch(/<a href="\/about">About<\/a>/);
    expect(html).toMatch(/<a href="\/login">Sign in<\/a>/);
    expect(html).toContain('class="shell-theme shell-theme--on-light"');
  });
});

describe('the top bar on its own', () => {
  it('1A Task 11 L2-44: TopBar renders the bar and the panel as two siblings, the panel after the bar', () => {
    at('/orgs/a/dashboard');
    const html = withoutPreloads(renderToStaticMarkup(<TopBar shell={shell} />));
    expect(html).toMatch(/^<header class="shell-topbar"><button [^>]*>[\s\S]*?<\/button><a [^>]*class="shell-topbar__brand"[^>]*>[\s\S]*?<\/a><\/header><div [^>]*id="shell-menu"/);
  });
});
