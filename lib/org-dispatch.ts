/**
 * Pure decision core for `app/page.tsx` (Task 6, constraint 6). See
 * __tests__/unit/org-dispatch.test.ts for the D-069 case this exists to
 * cover: `users.lastActiveOrgId` is unconstrained, FK-less TEXT that can
 * name an org the caller was removed from, so it is never trusted alone —
 * only used to pick a redirect target when it also names one of the
 * caller's own current, active memberships. Even then, the redirect target
 * (`/orgs/{slug}/dashboard`) passes back through `requireOrgContext` at the
 * `/orgs/[slug]` layout like any other request — this function grants
 * nothing by itself, it only chooses where to point the browser.
 */

export type OrgDispatch =
  | { kind: 'redirect'; slug: string }
  | { kind: 'picker'; orgs: { slug: string; name: string }[] };

export function resolveOrgDispatch(
  lastActiveOrgId: string | null,
  memberships: { orgId: string; org: { slug: string; name: string } }[],
): OrgDispatch {
  const hinted = lastActiveOrgId
    ? memberships.find((m) => m.orgId === lastActiveOrgId)
    : undefined;

  if (hinted) return { kind: 'redirect', slug: hinted.org.slug };

  return {
    kind: 'picker',
    orgs: memberships.map((m) => ({ slug: m.org.slug, name: m.org.name })),
  };
}
