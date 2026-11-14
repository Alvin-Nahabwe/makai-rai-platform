import { currentOrgSlug, isNavActive, resolveOrgHref } from '@/lib/org-nav';
import { SHELL_COPY } from '@/lib/shell/copy';
import type { RailItem } from '@/lib/shell/types';

/**
 * The rail's items and the role under the person's name (plan 1A Task 11, ruling L2-49), as pure functions of the address and
 * the person's own data: no React, no data access, no storage. Every address is a fixed application path or is built from the
 * current pathname's slug through resolveOrgHref (security obligation T5).
 */

/** Where Task 12 keeps the last project a person opened in an organisation. Nothing reads or writes it in this task. */
export const LAST_PROJECT_PREFIX = 'makrai:last-project:';
export const LAST_PROJECT_KEY = (userId: string, orgSlug: string): string => `${LAST_PROJECT_PREFIX}${userId}:${orgSlug}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINDINGS_PAGE = /^\/orgs\/[^/]+\/projects\/[^/]+\/findings(\/|$)/;

/**
 * Findings: the organisation's projects, chosen for their findings, with the last project the person opened when it is a
 * UUID. Anything else is dropped as if there were none, so nothing but an id reaches the address. The slug comes from the
 * pathname, already encoded, and is not encoded again.
 */
export function findingsHref(orgSlug: string, lastProjectId: string | null): string {
  const base = `/orgs/${orgSlug}/projects?for=findings`;
  return lastProjectId !== null && UUID.test(lastProjectId) ? `${base}&last=${lastProjectId}` : base;
}

type Draft = Omit<RailItem, 'label' | 'current'>;

/**
 * The rail's items, in order. The MAK-AI administrator has Organisations and Accounts (S-23, S-25, SRS line 1514) and no
 * organisation item (FR-ORG-03); a person in an organisation has Home, Projects, Findings and Guidance, then Members and
 * Organisation details; an account in no organisation has only Guidance (SRS 7.1.1). My account comes last for everyone.
 * At most one item is current. Help is added by Task 12, after Guidance, with its page.
 */
export function railItems(input: { pathname: string; isPlatformAdmin: boolean; hasOrganisation: boolean; findingsHref: string }): RailItem[] {
  const { pathname } = input;
  const account: Draft = { key: 'account', href: '/account', icon: 'user', group: 'lower' };
  const guidance: Draft = { key: 'guidance', href: '/explore/framework', icon: 'book-open', group: 'main' };
  let drafts: Draft[];
  if (input.isPlatformAdmin) {
    drafts = [
      { key: 'admin-organisations', href: '/admin/organisations', icon: 'building-2', group: 'main' },
      { key: 'admin-accounts', href: '/admin/accounts', icon: 'users', group: 'main' },
      account,
    ];
  } else if (input.hasOrganisation) {
    drafts = [
      { key: 'home', href: resolveOrgHref(pathname, '/dashboard'), icon: 'home', group: 'main' },
      { key: 'projects', href: resolveOrgHref(pathname, '/projects'), icon: 'folder', group: 'main' },
      { key: 'findings', href: input.findingsHref, icon: 'flag', group: 'main' },
      guidance,
      { key: 'members', href: resolveOrgHref(pathname, '/settings/members'), icon: 'users', group: 'lower' },
      { key: 'organisation', href: resolveOrgHref(pathname, '/settings/organisation'), icon: 'building-2', group: 'lower' },
      account,
    ];
  } else {
    drafts = [guidance, account];
  }
  const onFindings = FINDINGS_PAGE.test(pathname);
  const isCurrent = (d: Draft): boolean => {
    if (d.key === 'findings') return onFindings;
    if (d.key === 'projects') return !onFindings && isNavActive(pathname, d.href);
    if (d.key === 'guidance') return pathname.startsWith('/explore/');
    return isNavActive(pathname, d.href);
  };
  return drafts.map((d) => ({ ...d, label: SHELL_COPY.items[d.key], current: isCurrent(d) }));
}

/**
 * The role under the person's name: their role in the organisation whose page is open, or the platform label outside any
 * organisation. The slug is the visitor's own path segment, so it is looked up as an own property: `roleLabels['__proto__']`
 * would be Object.prototype, which React refuses to render, and S-31 (drawn inside the shell for an address the person has no
 * organisation at) would turn into an error page. A slug that is not one of the person's own organisations gets no role
 * (S-31: nothing tells a visitor whether that organisation exists).
 */
export function roleUnderName(pathname: string, roleLabels: Readonly<Record<string, string>>, platformLabel: string | null): string | null {
  const slug = currentOrgSlug(pathname);
  if (slug === undefined) return platformLabel;
  if (!Object.hasOwn(roleLabels, slug)) return null;
  const label = roleLabels[slug];
  return typeof label === 'string' ? label : null;
}
