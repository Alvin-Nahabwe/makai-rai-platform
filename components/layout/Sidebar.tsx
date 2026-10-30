'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import ThemeToggle from './ThemeToggle';
import { SignOutWithDraftsGuard } from '@/components/decision/SignOutWithDraftsGuard';
import { currentOrgSlug, resolveOrgHref, isNavActive } from '@/lib/org-nav';

/**
 * What the layout hands the sidebar (UX-02). `roleLabels` holds the person's role in each organisation they are in, keyed by
 * slug, and `platformLabel` is "MAK-AI administrator" or null; both come from `orgRoleLabel` (lib/authz/roleLabel.ts), which is
 * AUTHZ's. The account's platform role field is not a prop: the sidebar cannot show it (SRS 7.1.1, UX-02).
 */
export type SidebarProps = {
  userName: string;
  userId: string;
  roleLabels: Record<string, string>;
  platformLabel: string | null;
  orgCount: number;
};

/**
 * `/admin/assessments` is gone — that page is deleted by Task 7 (D-006).
 * `/admin/users` and `/admin/settings` stay at their PLATFORM paths, shown only in the
 * MAK-AI administrator shell. ORG renames them to Organisations and Accounts when it moves
 * the pages (S-23, S-25); this component adds no administrator item.
 */
const adminItems = [
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/settings', label: 'Settings' },
];

/**
 * The role under the person's name: their role in the organisation whose page is open, or the platform label outside any
 * organisation. The slug is the visitor's own path segment, so it is looked up as an own property: `roleLabels['__proto__']`
 * would be Object.prototype, which React refuses to render, and S-31 (drawn inside this sidebar for an address the person
 * has no organisation at) would turn into an error page. A slug that is not one of the person's own organisations gets no role.
 */
function roleUnderName(pathname: string, roleLabels: Record<string, string>, platformLabel: string | null): string | null {
  const slug = currentOrgSlug(pathname);
  if (slug === undefined) return platformLabel;
  if (!Object.hasOwn(roleLabels, slug)) return null;
  const label = roleLabels[slug];
  return typeof label === 'string' ? label : null;
}

export default function Sidebar({ userName, userId, roleLabels, platformLabel, orgCount }: SidebarProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isPlatformAdmin = platformLabel !== null;
  const role = roleUnderName(pathname, roleLabels, platformLabel);

  // Org-scoped destinations resolve against whatever org the current path is
  // in; outside org scope they fall back to `/`, the dispatcher (never a
  // stale unprefixed path like the old hardcoded `/dashboard`) — see
  // lib/org-nav.ts. The MAK-AI administrator shell has no organisation items at all
  // (FR-ORG-03), and an account in no organisation sees only Explore (SRS 7.1.1).
  const orgItems = [
    { href: resolveOrgHref(pathname, '/dashboard'), label: 'Dashboard' },
    { href: resolveOrgHref(pathname, '/projects'), label: 'Projects' },
    { href: resolveOrgHref(pathname, '/settings/members'), label: 'Members' },
    { href: resolveOrgHref(pathname, '/settings/organisation'), label: 'Organisation' },
  ];
  const exploreItems = [
    { href: '/explore/framework', label: 'Framework' },
    { href: '/explore/controls', label: 'Controls' },
    { href: '/about', label: 'About' },
  ];
  const showOrgItems = !isPlatformAdmin && orgCount > 0;

  const renderLink = (item: { href: string; label: string }) => (
    <Link key={item.label} href={item.href} onClick={() => setOpen(false)}
      className={`sidebar-link ${isNavActive(pathname, item.href) ? 'active' : ''}`}>
      {item.label}
    </Link>
  );

  // On mobile the drawer is dismissed by tapping a nav link (see onClick below),
  // the overlay, or Escape — no route-syncing effect required.

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  return (
    <>
      {/* Hamburger toggle — visible only on mobile */}
      <button
        className="sidebar-toggle"
        onClick={() => setOpen(!open)}
        aria-label={open ? 'Close navigation' : 'Open navigation'}
        aria-expanded={open}
      >
        <span className="sidebar-toggle__bar" />
        <span className="sidebar-toggle__bar" />
        <span className="sidebar-toggle__bar" />
      </button>

      {/* Overlay — visible only when sidebar is open on mobile */}
      {open && <div className="sidebar-overlay" onClick={() => setOpen(false)} />}

      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-header">
          <Image src="/logo-makai-white.png" alt="MAK-AI" className="sidebar-logo" width={120} height={40} priority />
          <span className="sidebar-title">RAI Toolkit</span>
        </div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {/*
            Switching organisation is a NAVIGATION to another slug, never a
            state mutation (Task 6 constraint 5) — that is what keeps
            browser tabs independent (switching in one tab cannot silently
            re-point another). `/` re-derives the target from
            `lastActiveOrgId` (a hint only) or shows an org picker if that
            hint is absent or stale, so this is always a plain link, never a
            client-side org-swap. Shown only to a member of more than one organisation.
          */}
          {showOrgItems && orgCount > 1 && renderLink({ href: '/', label: 'Switch organisation' })}
          {showOrgItems && orgItems.map(renderLink)}
          {isPlatformAdmin && (
            <>
              <div className="sidebar-section-label">{platformLabel}</div>
              {adminItems.map(renderLink)}
              <div className="sidebar-divider" />
            </>
          )}
          <div className="sidebar-section-label">Explore</div>
          {exploreItems.map(renderLink)}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-user">
            <span className="sidebar-user-name">{userName}</span>
            {role !== null && <span className="sidebar-user-role">{role}</span>}
          </div>
          <Link href="/account" onClick={() => setOpen(false)}
            className={`sidebar-link ${isNavActive(pathname, '/account') ? 'active' : ''}`}>
            My account
          </Link>
          <div className="sidebar-footer__actions">
            <SignOutWithDraftsGuard userId={userId}>
              <button onClick={() => signOut({ callbackUrl: '/login' })} className="sidebar-signout">Sign out</button>
            </SignOutWithDraftsGuard>
            <ThemeToggle />
          </div>
        </div>
      </aside>
    </>
  );
}
