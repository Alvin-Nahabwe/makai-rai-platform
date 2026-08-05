'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import ThemeToggle from './ThemeToggle';
import { resolveOrgHref, isNavActive } from '@/lib/org-nav';

interface SidebarProps { userName: string; userRole: string; }

/**
 * `/admin/assessments` is gone — that page is deleted by Task 7 (D-006).
 * `/admin/users` and `/admin/settings` stay at their PLATFORM paths and
 * PLATFORM-role gate below, unlike the brief's literal "gate on org role"
 * text — see the Task 6 report for why: both pages remain genuinely
 * platform-wide (all users, platform-wide counts), not org-scoped, per the
 * plan's own "Deleted" list (only admin/assessments is removed). There is
 * no org-scoped replacement page for Task 6 to point at yet — that ships in
 * Task 8 (`orgs/[slug]/settings/members`). Gating a platform-wide page by an
 * arbitrary org's role would show org owners/admins of ANY org a link that
 * 403s for them — a defect, not a fix.
 */
const adminItems = [
  { href: '/admin/users', label: 'Users', icon: '👥' },
  { href: '/admin/settings', label: 'Settings', icon: '⚙️' },
];

export default function Sidebar({ userName, userRole }: SidebarProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Org-scoped destinations resolve against whatever org the current path is
  // in; outside org scope they fall back to `/`, the dispatcher (never a
  // stale unprefixed path like the old hardcoded `/dashboard`) — see
  // components/layout/orgNav.ts.
  const navItems = [
    { href: resolveOrgHref(pathname, '/dashboard'), label: 'Dashboard', icon: '📊' },
    { href: resolveOrgHref(pathname, '/projects'), label: 'Projects', icon: '📁' },
    // Task 8: the org-scoped members-management page D-118 named as this
    // task's deliverable. `resolveOrgHref` falls back to `/` outside an org
    // scope, same as every other org-scoped item here.
    { href: resolveOrgHref(pathname, '/settings/members'), label: 'Members', icon: '👥' },
    { href: '/explore/framework', label: 'Framework', icon: '🗺️' },
    { href: '/explore/controls', label: 'Controls', icon: '🛡️' },
    { href: '/explore/about', label: 'About', icon: 'ℹ️' },
  ];

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
          {navItems.map((item) => (
            <Link key={item.label} href={item.href} onClick={() => setOpen(false)}
              className={`sidebar-link ${isNavActive(pathname, item.href) ? 'active' : ''}`}>
              <span className="sidebar-icon">{item.icon}</span>{item.label}
            </Link>
          ))}
          {/*
            Switching organization is a NAVIGATION to another slug, never a
            state mutation (Task 6 constraint 5) — that is what keeps
            browser tabs independent (switching in one tab cannot silently
            re-point another). `/` re-derives the target from
            `lastActiveOrgId` (a hint only) or shows an org picker if that
            hint is absent or stale, so this is always a plain link, never a
            client-side org-swap.
          */}
          <Link href="/" onClick={() => setOpen(false)} className="sidebar-link">
            <span className="sidebar-icon">🔀</span>Switch organization
          </Link>
          {userRole === 'admin' && (
            <>
              <div className="sidebar-divider" />
              <div className="sidebar-section-label">Admin</div>
              {adminItems.map((item) => (
                <Link key={item.label} href={item.href} onClick={() => setOpen(false)}
                  className={`sidebar-link ${isNavActive(pathname, item.href) ? 'active' : ''}`}>
                  <span className="sidebar-icon">{item.icon}</span>{item.label}
                </Link>
              ))}
            </>
          )}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-user">
            <span className="sidebar-user-name">{userName}</span>
            <span className="sidebar-user-role">{userRole}</span>
          </div>
          <div className="sidebar-footer__actions">
            <button onClick={() => signOut({ callbackUrl: '/login' })} className="sidebar-signout">Sign Out</button>
            <ThemeToggle />
          </div>
        </div>
      </aside>
    </>
  );
}
