/**
 * Pure helpers for resolving app-relative paths against the current org
 * scope. Homed in `lib/`, not `components/`, because this is routing
 * infrastructure, not a Sidebar-only concern: the 7 pages `git mv`'d under
 * `app/(authenticated)/orgs/[slug]/` by this task still hardcode unprefixed
 * internal links/redirects (e.g. `router.push('/dashboard')`,
 * `href="/projects/new"`) that Task 7 ("the port") will need to fix the same
 * way `Sidebar.tsx` does here — via `currentOrgSlug`/`resolveOrgHref`, not a
 * seventh hand-rolled copy of the same prefixing logic.
 *
 * Extracted so the href/active-state logic is unit-testable without React or
 * a DOM (see __tests__/unit/org-nav.test.ts) — this project has neither
 * React Testing Library nor a jsdom vitest environment configured.
 */

const ORG_SLUG_PATTERN = /^\/orgs\/([^/]+)/;

/** The org slug segment of a pathname, or `undefined` outside `/orgs/*`. */
export function currentOrgSlug(pathname: string): string | undefined {
  return ORG_SLUG_PATTERN.exec(pathname)?.[1];
}

/**
 * Resolves an org-scoped nav destination against the CURRENT org (derived
 * from `pathname`), never a stale unprefixed path. When there is no current
 * org — the sidebar renders on `/explore/*`, `/admin/*` and
 * `/change-password` too, none of which carry a slug — falls back to `/`,
 * the redirect dispatcher (app/page.tsx), which resolves the right org from
 * `lastActiveOrgId` (a hint only) or shows an org picker. Never falls back
 * to the old unprefixed path (e.g. `/dashboard`), which no longer exists.
 */
export function resolveOrgHref(pathname: string, path: string): string {
  const slug = currentOrgSlug(pathname);
  return slug ? `/orgs/${slug}${path}` : '/';
}

/**
 * Whether a nav item should render as active. Replaces the bare
 * `pathname.startsWith(item.href)` that broke once org-scoped paths gained a
 * `/orgs/{slug}` prefix (constraint 4): a stale unprefixed href like
 * `/dashboard` would never match a pathname of `/orgs/acme/dashboard`.
 *
 * `/` — `resolveOrgHref`'s fallback when there is no current org — is never
 * "active": every pathname starts with `/`, so treating it as a real
 * destination would light up every org-scoped nav item on every non-org
 * page (explore, admin, change-password).
 */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === '/') return false;
  return pathname.startsWith(href);
}
