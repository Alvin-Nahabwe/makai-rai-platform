'use client';

import Link from 'next/link';
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
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <img src="/logo-makai-white.png" alt="MAK-AI" className="sidebar-logo" />
        <span className="sidebar-title">RAI Toolkit</span>
      </div>
      <nav className="sidebar-nav" aria-label="Main navigation">
        {navItems.map((item) => (
          <Link key={item.href} href={item.href}
            className={`sidebar-link ${pathname.startsWith(item.href) ? 'active' : ''}`}>
            <span className="sidebar-icon">{item.icon}</span>{item.label}
          </Link>
        ))}
        {userRole === 'admin' && (
          <>
            <div className="sidebar-divider" />
            <div className="sidebar-section-label">Admin</div>
            {adminItems.map((item) => (
              <Link key={item.href} href={item.href}
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
  );
}
