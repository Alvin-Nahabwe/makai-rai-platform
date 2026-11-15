import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { routeFiles, routeLabel } from '../../scripts/redesign/screen-stages.mjs';

/**
 * Plan 1B Task 1 (C1, T1.1 to T1.7): the signed-in pages that live outside the shell (S-05 acceptances, S-29 change
 * password, S-07 the organisation chooser at `/`) form the route group app/(gate), rendered in the gate frame. A route
 * group changes no address (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route-groups.md:12),
 * so every address of v0.6.0 is still served, and the gates run in each page as before.
 */

const GATE = 'app/(gate)';

/** The page files under `dir`, as paths relative to it, sorted. */
function pagesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === 'page.tsx') out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** Every .ts/.tsx file under `dir`. */
function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** Code only: block and line comments removed, so a comment that names a call is not a call. */
const code = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

/** The page routes of `app`, as screen-stages.mjs labels them, without the development-only gallery (404 in production). */
const routesOf = (appDir: string): string[] =>
  (routeFiles(appDir) as string[]).filter((f) => f.endsWith('/page.tsx')).map((f) => routeLabel(f) as string).sort();

/** The 38 page addresses at the base of this task (c1c933b6), from screen-stages.mjs's walk of app/ that day. */
const ROUTES_AT_BASE = [
  '/', '/about', '/acceptances', '/account', '/admin/accounts', '/admin/organisations', '/admin/organisations/[id]',
  '/admin/organisations/new', '/change-password', '/explore/controls', '/explore/framework', '/forgot-password', '/help',
  '/invitations/[token]', '/legal/[kind]', '/legal/[kind]/[version]', '/login', '/orgs/[slug]/dashboard', '/orgs/[slug]/export',
  '/orgs/[slug]/projects', '/orgs/[slug]/projects/[id]', '/orgs/[slug]/projects/[id]/edit', '/orgs/[slug]/projects/[id]/export',
  '/orgs/[slug]/projects/[id]/findings', '/orgs/[slug]/projects/[id]/findings/[findingId]',
  '/orgs/[slug]/projects/[id]/reviews/[reviewId]', '/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents',
  '/orgs/[slug]/projects/[id]/reviews/[reviewId]/seal', '/orgs/[slug]/projects/[id]/reviews/new', '/orgs/[slug]/projects/[id]/stages/[stage]',
  '/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]',
  '/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]/history', '/orgs/[slug]/projects/new',
  '/orgs/[slug]/settings/members', '/orgs/[slug]/settings/organisation', '/privacy', '/reset-password', '/terms',
].sort();

describe('the (gate) route group (plan 1B Task 1)', () => {
  it('C1: (gate) holds exactly acceptances, change-password and the root page', () => {
    expect(pagesUnder(GATE)).toEqual(['acceptances/page.tsx', 'change-password/page.tsx', 'page.tsx']);
  });

  it('C1: the moved pages left their old places (no second copy of an address)', () => {
    // Files, not directories: a copy of the tree that drops files but keeps empty directories (a sync) still serves nothing.
    const gonePages = ['app/page.tsx', 'app/(authenticated)/acceptances/page.tsx', 'app/(authenticated)/change-password/page.tsx',
      'app/(authenticated)/change-password/layout.tsx', 'app/(authenticated)/change-password/ChangePasswordForm.tsx'];
    for (const gone of gonePages) {
      expect(existsSync(gone), gone).toBe(false);
    }
  });

  it('C1: no address moved', () => {
    expect(routesOf('app').filter((r) => !r.startsWith('/dev/'))).toEqual(ROUTES_AT_BASE);
  });

  it('T1.1 T1.7: every (gate) page calls requireIdentity in its own code', () => {
    for (const p of pagesUnder(GATE)) expect(code(`${GATE}/${p}`), p).toMatch(/\bawait requireIdentity\(\)/);
  });

  it('T1.1: the group layout never redirects: a gate redirect thrown by it to a sibling page (/ to /acceptances) loops the client router', () => {
    // Seen on a dev server and a production build (e2e/acceptances.spec.ts:443): after sign-in, router.push('/') with the
    // layout's requireIdentity() redirecting to /acceptances refetched /acceptances without end and rendered no page. The
    // pages gate themselves (above); the layout reads the identity only to decide on the idle warning.
    const src = code(`${GATE}/layout.tsx`);
    expect(src).not.toMatch(/requireIdentity\(|redirect\(|notFound\(/);
    expect(src).toMatch(/await tryResolveIdentity\(\)/);
  });

  it('T1.2: the pages gate 3 exempts are unchanged, by exact path (the addresses did not move)', () => {
    const m = /export const ACCEPTANCE_EXEMPT_PATHS = (\[[^\]]*\])/.exec(readFileSync('lib/auth/identity.ts', 'utf8'));
    expect(m?.[1]).toBe("['/acceptances', '/account', '/change-password']");
  });

  it('T1.5: `/` sends the MAK-AI administrator to /admin/organisations before it reads any membership, and dispatches as before', () => {
    const src = code(`${GATE}/page.tsx`);
    const admin = src.indexOf("if (identity.platformRole === 'admin') redirect('/admin/organisations');");
    expect(admin).toBeGreaterThan(src.indexOf('await requireIdentity()'));
    for (const later of ['membershipsForUser(identity.userId)', 'resolveOrgDispatch(']) {
      expect(src.indexOf(later), later).toBeGreaterThan(admin);
    }
    expect(src).toContain('const dispatch = resolveOrgDispatch(user?.lastActiveOrgId ?? null, memberships);');
    expect(src).toContain('redirect(`/orgs/${dispatch.slug}/dashboard`);');
  });

  it('T1.6: nothing in (gate) renders the shell, its rail or the newer-text notice (offers stay on in-shell pages)', () => {
    for (const f of [...sourcesUnder(GATE), 'components/layout/GateFrame.tsx', 'components/layout/GateSignOut.tsx']) {
      expect(code(f), f).not.toMatch(/AppShell|\bRail\b|TopBar|NewerLegalTextNotice|NewerLegalTextOffers|OrgSwitcher/);
    }
  });

  it('T1.4: the (gate) pages and the frame read no tenant data: every module they import from lib, Prisma or a relative path is on an allow-list', () => {
    // Review R1-2: an allow-list, not a block-list, so any new reader (a data module, a loader, a guard) fails here until it
    // is looked at. The data readers among them are the identity lane's own four.
    const ALLOWED = [
      './ChangePasswordForm', '@/lib/auth/copy', '@/lib/auth/identity', '@/lib/auth/idle', '@/lib/auth/idleDeadline',
      '@/lib/client/draftKeys', '@/lib/client/signOutPress', '@/lib/client/useHydrated', '@/lib/data/acceptances',
      '@/lib/data/identity', '@/lib/data/preauth', '@/lib/decision/drafts/copy', '@/lib/legal/copy', '@/lib/legal/registry',
      '@/lib/org-dispatch', '@/lib/org/copy', '@/lib/shell/copy', '@/lib/ui/copy', '@/lib/ui/title', '@/lib/validate',
    ];
    const files = [...sourcesUnder(GATE), 'components/layout/GateFrame.tsx', 'components/layout/GateSignOut.tsx'];
    const used = new Set<string>();
    for (const f of files) {
      for (const m of code(f).matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2];
        if (/^(@\/lib\/|@prisma\/|\.\.?\/)/.test(spec)) used.add(spec);
      }
    }
    expect([...used].filter((spec) => !ALLOWED.includes(spec)).sort()).toEqual([]);
    expect([...used].filter((spec) => /^@\/lib\/(data\/|auth\/identity$)/.test(spec)).sort())
      .toEqual(['@/lib/auth/identity', '@/lib/data/acceptances', '@/lib/data/identity', '@/lib/data/preauth']);
    // The one identity read: this person's last organisation, by their own id.
    const chooser = code(`${GATE}/page.tsx`);
    expect(chooser.match(/identityDb\./g)).toHaveLength(1);
    expect(chooser).toMatch(/identityDb\.user\.findUnique\(\{\s*where: \{ id: identity\.userId \},\s*select: \{ lastActiveOrgId: true \},\s*\}\)/);
    expect(chooser).toContain('membershipsForUser(identity.userId)');
  });

  it('T1.3 T1.6: no org-scoped address is written in the frame, the group layout or the acceptances and change-password pages', () => {
    // The chooser at `/` links each of the person's organisations: that list is the page, reached only once requireIdentity
    // has passed gates 2 and 3 (a flagged or unaccepted account is redirected before it renders).
    const files = [
      'components/layout/GateFrame.tsx', 'components/layout/GateSignOut.tsx', `${GATE}/layout.tsx`,
      ...sourcesUnder(`${GATE}/acceptances`), ...sourcesUnder(`${GATE}/change-password`),
    ];
    // The one exception: M-41's Go to them in GateSignOut.tsx, the drafts list of My account, which the frame shows only
    // when gate 3 or no gate holds the account (not to a flagged one, gate 2), and only after a Sign out press finds drafts.
    const m41 = '"/account#drafts-on-this-device"';
    expect(code('components/layout/GateSignOut.tsx').split(m41)).toHaveLength(2);
    // And S-21's voluntary change (plan 1B Task 3, T3.2): Back to My account, in the view's footer only when the identity is
    // not flagged (`forced` is identity.mustChangePassword, read by the page on the server, T3.1).
    const back = '<Link href="/account">';
    const form = `${GATE}/change-password/ChangePasswordForm.tsx`;
    expect(code(form).split(back)).toHaveLength(2);
    expect(code(form)).toMatch(/const footer = v\.forced \? null : <p><Link href="\/account">/);
    for (const f of files) expect(code(f).replace(m41, '').replace(back, ''), f).not.toMatch(/\/orgs\/|\/projects|\/settings|\/account\b|\/admin\//);
  });

  it('the group layout renders the idle warning when the deadlines are read, and the frame no newer-text notice', () => {
    const src = code(`${GATE}/layout.tsx`);
    expect(src).toMatch(/readSessionDeadlines\(await headers\(\)\)/);
    expect(src).toMatch(/<IdleWarning /);
  });
});
