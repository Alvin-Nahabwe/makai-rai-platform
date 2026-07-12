'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';

interface SidebarProps { userName: string; userRole: string; }

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: '📊' },
  { href: '/projects', label: 'Projects', icon: '📁' },
  { href: '/explore/framework', label: 'Framework', icon: '🗺️' },
  { href: '/explore/controls', label: 'Controls', icon: '🛡️' },
  { href: '/explore/about', label: 'About', icon: 'ℹ️' },
];

const adminItems = [
  { href: '/admin/users', label: 'Users', icon: '👥' },
  { href: '/admin/assessments', label: 'All Assessments', icon: '📋' },
  { href: '/admin/settings', label: 'Settings', icon: '⚙️' },
];

export default function Sidebar({ userName, userRole }: SidebarProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

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
            <Link key={item.href} href={item.href} onClick={() => setOpen(false)}
              className={`sidebar-link ${pathname.startsWith(item.href) ? 'active' : ''}`}>
              <span className="sidebar-icon">{item.icon}</span>{item.label}
            </Link>
          ))}
          {userRole === 'admin' && (
            <>
              <div className="sidebar-divider" />
              <div className="sidebar-section-label">Admin</div>
              {adminItems.map((item) => (
                <Link key={item.href} href={item.href} onClick={() => setOpen(false)}
                  className={`sidebar-link ${pathname.startsWith(item.href) ? 'active' : ''}`}>
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
          <button onClick={() => signOut({ callbackUrl: '/login' })} className="sidebar-signout">Sign Out</button>
        </div>
      </aside>
    </>
  );
}
