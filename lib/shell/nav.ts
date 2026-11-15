import { currentOrgSlug, isNavActive, orgHref } from '@/lib/org-nav';
import { SHELL_COPY } from '@/lib/shell/copy';
import type { RailItem, ShellOrg } from '@/lib/shell/types';
import { STAGES, type Stage } from '@/types/record';

/**
 * The rail's items and the role under the person's name (plan 1A Task 11, ruling L2-49), as pure functions of the address and
 * the person's own data: no React, no data access, no storage. Every address is a fixed application path or is built from one
 * slug through orgHref (lib/org-nav.ts) (security obligation T5). That slug is railOrgSlug's: the address's own slug, or else
 * (S4) one of the person's own organisations, matched by slug against ShellData.orgs (their active memberships): the last
 * one seen in an address while the shell stayed mounted, or the server's homeSlug. Nothing else is a source of a slug, and
 * every organisation address still passes requireOrgContext at the /orgs/[slug] layout: a link grants nothing.
 */

/** Whether a slug is one of the person's own organisations: an array match, never a property lookup (`__proto__`, T3). */
function isOwn(slug: string | null, orgs: readonly ShellOrg[]): slug is string {
  return slug !== null && orgs.some((o) => o.slug === slug);
}

/**
 * S4 rule 2: the last of the person's own organisations seen in an address. An address in one of them replaces what was
 * remembered; any other address (Help, My account, Guidance, an organisation the person is not in) keeps it.
 */
export function rememberOrgSlug(previous: string | null, pathname: string, orgs: readonly ShellOrg[]): string | null {
  const slug = currentOrgSlug(pathname) ?? null;
  return isOwn(slug, orgs) ? slug : previous;
}

/**
 * The organisation the rail links to (S4), in this order: the address's slug (as before; the /orgs/[slug] layout decides
 * whether the person may be there); else the last of their own organisations seen while the shell stayed mounted; else the
 * server's homeSlug (the organisation `/` would send them to); else none, and the organisation links stay `/` (the
 * chooser). The last two are used only when they are among the person's own organisations (T1).
 */
export function railOrgSlug(
  pathname: string,
  lastSeen: string | null,
  shell: { orgs: readonly ShellOrg[]; homeSlug: string | null },
): string | null {
  const fromAddress = currentOrgSlug(pathname);
  if (fromAddress !== undefined) return fromAddress;
  if (isOwn(lastSeen, shell.orgs)) return lastSeen;
  if (isOwn(shell.homeSlug, shell.orgs)) return shell.homeSlug;
  return null;
}

/**
 * Where the last project a person opened in an organisation is kept. Read and written only by lib/client/lastProject.ts
 * (plan 1A Task 12, L2-64), which this module re-exports the key from and otherwise leaves alone: it stays storage-free.
 */
export { LAST_PROJECT_PREFIX, LAST_PROJECT_KEY } from '@/lib/client/lastProject';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value is a string shaped like a UUID: the one test the Findings link and the Projects page share (L2-65). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
const FINDINGS_PAGE = /^\/orgs\/[^/]+\/projects\/[^/]+\/findings(\/|$)/;

/**
 * Findings: the organisation's projects, chosen for their findings, with the last project the person opened when it is a
 * UUID. Anything else is dropped as if there were none, so nothing but an id reaches the address. The slug is railOrgSlug's
 * and the address is built by orgHref, which does not encode it again.
 */
export function findingsHref(orgSlug: string, lastProjectId: string | null): string {
  const base = orgHref(orgSlug, '/projects?for=findings');
  return isUuid(lastProjectId) ? `${base}&last=${lastProjectId}` : base;
}

type Draft = Omit<RailItem, 'label' | 'current'>;

/**
 * The rail's items, in order. The MAK-AI administrator has Organisations and Accounts (S-23, S-25, SRS line 1514) and no
 * organisation item (FR-ORG-03); a person in an organisation has Home, Projects, Findings and Guidance, then Members and
 * Organisation details; an account in no organisation has only Guidance (SRS 7.1.1). My account comes last for everyone.
 * Help (plan 1A Task 12, L2-48) follows Guidance for a person in an organisation and for an account in none; the
 * administrator's rail has none (answer iv). At most one item is current.
 */
export function railItems(input: {
  pathname: string;
  /** railOrgSlug's answer: the organisation the organisation items link to, or null for `/`. */
  orgSlug: string | null;
  isPlatformAdmin: boolean;
  hasOrganisation: boolean;
  findingsHref: string;
}): RailItem[] {
  const { pathname, orgSlug } = input;
  const account: Draft = { key: 'account', href: '/account', icon: 'user', group: 'lower' };
  const guidance: Draft = { key: 'guidance', href: '/explore/framework', icon: 'book-open', group: 'main' };
  const help: Draft = { key: 'help', href: '/help', icon: 'circle-help', group: 'main' };
  let drafts: Draft[];
  if (input.isPlatformAdmin) {
    drafts = [
      { key: 'admin-organisations', href: '/admin/organisations', icon: 'building-2', group: 'main' },
      { key: 'admin-accounts', href: '/admin/accounts', icon: 'users', group: 'main' },
      account,
    ];
  } else if (input.hasOrganisation) {
    drafts = [
      { key: 'home', href: orgHref(orgSlug, '/dashboard'), icon: 'home', group: 'main' },
      { key: 'projects', href: orgHref(orgSlug, '/projects'), icon: 'folder', group: 'main' },
      { key: 'findings', href: input.findingsHref, icon: 'flag', group: 'main' },
      guidance,
      help,
      { key: 'members', href: orgHref(orgSlug, '/settings/members'), icon: 'users', group: 'lower' },
      { key: 'organisation', href: orgHref(orgSlug, '/settings/organisation'), icon: 'building-2', group: 'lower' },
      account,
    ];
  } else {
    drafts = [guidance, help, account];
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

/**
 * The stage a project page's `[stage]` param names, or null (no param, or not one of the three stages): compared as a value
 * in STAGES, never as a property lookup.
 */
export function stageParam(stage: string | undefined): Stage | null {
  return STAGES.find((s) => s === stage) ?? null;
}
