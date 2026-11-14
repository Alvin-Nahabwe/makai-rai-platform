'use client';

import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { Icon } from '@/components/ui/Icon';
import OrgSwitcher from '@/components/layout/OrgSwitcher';
import ThemeToggle from '@/components/layout/ThemeToggle';
import { SignOutWithDraftsGuard } from '@/components/decision/SignOutWithDraftsGuard';
import { currentOrgSlug } from '@/lib/org-nav';
import { clearLastProjects, readLastProject, subscribeLastProject } from '@/lib/client/lastProject';
import { findingsHref, railItems, roleUnderName } from '@/lib/shell/nav';
import { SHELL_COPY } from '@/lib/shell/copy';
import { PRODUCT_NAME } from '@/lib/ui/title';
import type { RailItem, ShellData } from '@/lib/shell/types';
import './shell.css';

function Item({ item }: { item: RailItem }) {
  return (
    <li>
      <Link
        href={item.href}
        className={item.current ? 'shell-rail__item shell-rail__item--current' : 'shell-rail__item'}
        aria-current={item.current ? 'page' : undefined}
      >
        <Icon name={item.icon} />
        <span>{item.label}</span>
      </Link>
    </li>
  );
}

/**
 * The rail (plan 1A Task 11, rulings L2-52 and L2-60): the one navigation landmark, holding the product name, the organisation
 * switcher (not for the platform administrator, L2-61), the items, Sign out and the theme switch, so a person moving by
 * landmarks reaches all of them. Navy in both themes, with the current item a filled orange shape and white text; no text on it
 * is ever orange.
 *
 * Under the person's name it shows their role in the organisation whose page is open, or "MAK-AI administrator" outside any
 * organisation (UX-02); the account's platform role field is not in ShellData, so it cannot be shown. The role and the
 * switcher's name are looked up in the person's own data, never taken from the address (S-31).
 *
 * Findings carries the last project this person opened in this organisation (plan 1A Task 12, P2): read from
 * lib/client/lastProject.ts through useSyncExternalStore, so the server and hydration renders give the plain address and the
 * stored one arrives after hydration and again whenever RememberProject writes. Sign out goes through SignOutWithDraftsGuard
 * with the person's own id (M-41, NFR-PRIV-06) and first clears this person's last-project keys (L2-66, S4).
 */
export default function Rail({ shell }: { shell: ShellData }) {
  const pathname = usePathname();
  const slug = currentOrgSlug(pathname);
  const last = useSyncExternalStore(
    subscribeLastProject,
    () => (slug ? readLastProject(shell.userId, slug) : null),
    () => null,
  );
  const items = railItems({
    pathname,
    isPlatformAdmin: shell.platformLabel !== null,
    hasOrganisation: shell.orgs.length > 0,
    findingsHref: slug ? findingsHref(slug, last) : '/',
  });
  const role = roleUnderName(pathname, shell.roleLabels, shell.platformLabel);

  return (
    <nav className="shell-rail" aria-label={SHELL_COPY.nav}>
      <p className="shell-rail__product">{PRODUCT_NAME}</p>
      {shell.platformLabel === null && shell.orgs.length > 0 ? (
        <div className="shell-rail__org">
          <OrgSwitcher orgs={shell.orgs} currentSlug={slug ?? null} />
        </div>
      ) : null}
      <div className="shell-rail__nav">
        <ul className="shell-rail__main">
          {items.filter((i) => i.group === 'main').map((item) => <Item key={item.key} item={item} />)}
        </ul>
        <ul className="shell-rail__lower">
          {items.filter((i) => i.group === 'lower' && i.key !== 'account').map((item) => <Item key={item.key} item={item} />)}
          <li className="shell-rail__person">
            <span className="shell-rail__name">{shell.userName}</span>
            {role !== null ? <span className="shell-rail__role">{role}</span> : null}
          </li>
          {items.filter((i) => i.key === 'account').map((item) => <Item key={item.key} item={item} />)}
        </ul>
      </div>
      <div className="shell-rail__actions">
        <SignOutWithDraftsGuard userId={shell.userId}>
          <button type="button" className="shell-rail__signout" onClick={() => {
            clearLastProjects(shell.userId);
            void signOut({ callbackUrl: '/login' });
          }}>
            <Icon name="log-out" />
            {SHELL_COPY.signOut}
          </button>
        </SignOutWithDraftsGuard>
        <ThemeToggle />
      </div>
    </nav>
  );
}
