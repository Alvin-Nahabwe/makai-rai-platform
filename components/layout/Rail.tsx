'use client';

import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOutClearingDrafts } from '@/lib/client/signOutClearingDrafts';
import { Icon } from '@/components/ui/Icon';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { signOutMessage, type SignOutPhase } from '@/lib/client/signOutPress';
import OrgSwitcher from '@/components/layout/OrgSwitcher';
import ThemeToggle from '@/components/layout/ThemeToggle';
import { ShellPlace } from '@/components/layout/ShellPlace';
import { MAKAI_LOGO } from '@/components/layout/logos';
import { SignOutWithDraftsGuard } from '@/components/decision/SignOutWithDraftsGuard';
import { currentOrgSlug, orgHref } from '@/lib/org-nav';
import { clearLastProjects, readLastProject, subscribeLastProject } from '@/lib/client/lastProject';
import { findingsHref, railItems, railOrgSlug, rememberOrgSlug, roleUnderName } from '@/lib/shell/nav';
import { SHELL_COPY } from '@/lib/shell/copy';
import { PRODUCT_NAME } from '@/lib/ui/title';
import type { RailItem, ShellData } from '@/lib/shell/types';
import './shell.css';

/**
 * The rail's Sign out press. `show` hears `working` first (it empties the line, so a second identical refusal is announced
 * again), then `stillSignedIn` when signOutClearingDrafts REJECTS (SignOutNotEnded, SignOutTimedOut or the request's own
 * error: the session did not end and nothing navigated). Success leaves the phase at `working`, as the browser is leaving.
 * `pending` is the press's latch: a second press while one is unsettled is ignored; a refusal opens it again.
 * The kind of error is logged, never its message: the callbackUrl can hold a token.
 */
export async function signOutFromRail(userId: string, show: (phase: SignOutPhase) => void, pending: { current: boolean }): Promise<void> {
  if (pending.current) return;
  pending.current = true;
  show('working');
  clearLastProjects(userId);
  try {
    await signOutClearingDrafts(userId, '/login');
  } catch (err: unknown) {
    console.warn('rail: a sign-out press was rejected', err instanceof Error ? err.name : typeof err);
    pending.current = false;
    show('stillSignedIn');
  }
}

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
 * The rail (plan 1A Task 11, rulings L2-52 and L2-60): the one navigation landmark, holding the brand (the MAK-AI logo and the
 * platform's name under it, one link to Home, as the locked sketch draws it), the organisation switcher (not for the platform
 * administrator, L2-61), the items, the project block when a project is in context (the `@project` slot, owner ruling R4,
 * between the main items and the lower group), and, in a foot that stays put while the part above scrolls (review D4), the
 * person and their role, My account, Sign out and the theme switch, so a person moving by
 * landmarks reaches all of them. Navy in both themes, with the current item a filled orange shape and white text; no text on it
 * is in the action orange (the project block's "You are here" takes the on-shell accent token, see shell.css).
 *
 * Under the person's name it shows their role in the organisation whose page is open, or "MAK-AI administrator" outside any
 * organisation (UX-02); the account's platform role field is not in ShellData, so it cannot be shown. The role and the
 * switcher's name are looked up in the person's own data, never taken from the address (S-31).
 *
 * Findings carries the last project this person opened in this organisation (plan 1A Task 12, P2): read from
 * lib/client/lastProject.ts through useSyncExternalStore, so the server and hydration renders give the plain address and the
 * stored one arrives after hydration and again whenever RememberProject writes. Sign out goes through SignOutWithDraftsGuard
 * with the person's own id (M-41, NFR-PRIV-06) and first clears this person's last-project keys (L2-66, S4).
 *
 * The organisation items link to railOrgSlug's organisation (finding S4 of the workshop walk): on Help, My account and
 * Guidance, whose addresses carry no slug, that is the last of the person's own organisations seen in an address while this
 * rail stayed mounted (the signed-in layout outlives a client navigation, so its ShellData can be older than a switch), or
 * else the server's homeSlug. It is remembered in state, updated during render when the address names one of the person's
 * own organisations (React's "storing information from previous renders"), so the first render already has it.
 */
export default function Rail({ shell, project }: { shell: ShellData; project?: ReactNode }) {
  const pathname = usePathname();
  const addressSlug = currentOrgSlug(pathname);
  const signOutPending = useRef(false);
  const [signOutPhase, setSignOutPhase] = useState<SignOutPhase>('idle');
  // `working` is committed at once, so the line is empty in the page before a later refusal fills it again.
  const showSignOut = (next: SignOutPhase) => { if (next === 'working') flushSync(() => setSignOutPhase(next)); else setSignOutPhase(next); };
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const seen = rememberOrgSlug(lastSeen, pathname, shell.orgs);
  if (seen !== lastSeen) setLastSeen(seen);
  const slug = railOrgSlug(pathname, seen, shell);
  const last = useSyncExternalStore(
    subscribeLastProject,
    () => (slug ? readLastProject(shell.userId, slug) : null),
    () => null,
  );
  const items = railItems({
    pathname,
    orgSlug: slug,
    isPlatformAdmin: shell.platformLabel !== null,
    hasOrganisation: shell.orgs.length > 0,
    findingsHref: slug ? findingsHref(slug, last) : '/',
  });
  const role = roleUnderName(pathname, shell.roleLabels, shell.platformLabel);
  const lower = items.filter((i) => i.group === 'lower' && i.key !== 'account');

  return (
    <nav className="shell-rail" aria-label={SHELL_COPY.nav}>
      {/* From 1024 px this part scrolls when it must (shell.css: a thin scrollbar and a cue at each edge with more beyond);
          the foot below it stays put. Below 1024 px the Menu panel scrolls as a whole. */}
      <div className="shell-rail__scroll">
        {/* The logo is decorative beside the visible name inside the one link, so the link is read once: "MAK-AI RAI Platform".
            `/` only redirects (to the chooser, a gate or /login), so it is not prefetched, as in PublicHeader. */}
        <Link href={orgHref(slug, '/dashboard')} className="shell-rail__brand" prefetch={slug === null ? false : undefined}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a file already sized for the drawn logo (logos.ts). */}
          <img src={MAKAI_LOGO.src} srcSet={MAKAI_LOGO.srcSet} width={MAKAI_LOGO.width} height={MAKAI_LOGO.height} alt=""
            decoding="async" className="shell-rail__logo" />
          <span className="shell-rail__product">{PRODUCT_NAME}</span>
        </Link>
        {shell.platformLabel === null && shell.orgs.length > 0 ? (
          <div className="shell-rail__org">
            <OrgSwitcher orgs={shell.orgs} currentSlug={addressSlug ?? null} />
          </div>
        ) : null}
        <div className="shell-rail__nav">
          <ul className="shell-rail__main">
            {items.filter((i) => i.group === 'main').map((item) => <Item key={item.key} item={item} />)}
          </ul>
          {project ? <ShellPlace name="rail">{project}</ShellPlace> : null}
          {lower.length > 0 ? (
            <ul className="shell-rail__lower">
              {lower.map((item) => <Item key={item.key} item={item} />)}
            </ul>
          ) : null}
        </div>
      </div>
      {/* The pinned foot (design review D4): the person and their role, My account, Sign out and the theme switch. */}
      <div className="shell-rail__foot">
        <ul className="shell-rail__account">
          <li className="shell-rail__person">
            <span className="shell-rail__name">{shell.userName}</span>
            {role !== null ? <span className="shell-rail__role">{role}</span> : null}
          </li>
          {items.filter((i) => i.key === 'account').map((item) => <Item key={item.key} item={item} />)}
        </ul>
        <div className="shell-rail__actions">
          <SignOutWithDraftsGuard userId={shell.userId} onPhase={showSignOut}>
            <button type="button" className="shell-rail__signout" onClick={() => { void signOutFromRail(shell.userId, showSignOut, signOutPending); }}>
              <Icon name="log-out" />
              {SHELL_COPY.signOut}
            </button>
          </SignOutWithDraftsGuard>
          <ThemeToggle />
        </div>
        {/* Always in the page, empty until a sign-out is refused (the same sentence as S-05's), so it is announced when it fills.
            Assertive (role="alert"), as every other stillSignedIn surface: the person is not signed out and must know at once. */}
        <StatusRegion message={signOutMessage(signOutPhase)} politeness="assertive" tone="error" />
      </div>
    </nav>
  );
}
