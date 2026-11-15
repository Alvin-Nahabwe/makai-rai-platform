'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode, type ToggleEvent } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import Rail from '@/components/layout/Rail';
import { ShellPlace } from '@/components/layout/ShellPlace';
import { MAKAI_LOGO } from '@/components/layout/logos';
import { SHELL_COPY } from '@/lib/shell/copy';
import { orgHref } from '@/lib/org-nav';
import { railOrgSlug } from '@/lib/shell/nav';
import { PRODUCT_NAME } from '@/lib/ui/title';
import type { ShellData } from '@/lib/shell/types';
import './shell.css';

const PANEL_ID = 'shell-menu';
const OPEN_CLASS = 'shell-topbar__panel--open';
const WIDE = '(min-width: 1024px)';

/** Whether the panel is open as a popover. `:popover-open` is an unknown selector to a browser without popovers, and
 * matches() throws a SyntaxError on it there: such a browser has no open popover, so the answer is no. Any other error
 * is not this case and is thrown on. */
function isPopoverOpen(panel: HTMLElement): boolean {
  try {
    return panel.matches(':popover-open');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'SyntaxError') return false;
    throw error;
  }
}

/**
 * The top bar and the panel that holds the rail (plan 1A Task 11, rulings L2-44 to L2-46; modern-web-guidance `navbar`).
 *
 * Below 1024 px the bar shows the Menu button, then the MAK-AI logo linking Home (named "MAK-AI RAI Platform"), or, when a
 * project is in context (the `@project` slot, owner ruling R4), the stage and the project and "All questions" in its place
 * (shell.css hides the logo then: there is no room for both at 320 px). The button opens the panel natively with popovertarget,
 * with JavaScript or without it, and the browser closes it on Escape or a press outside and returns focus. From 1024 px CSS
 * hides the bar and shows the panel in the rail's column, open or not (components/layout/shell.css).
 *
 * With JavaScript the bar also: mirrors the panel's state into the button's aria-expanded (absent until then: with no script
 * the browser maps the popover's state itself); places the panel's top edge at the bar's bottom edge as it opens (no anchor
 * positioning); closes the panel on any press of a link inside it and when the address changes, since the layout outlives a
 * client navigation; closes it when the viewport reaches 1024 px. In a browser without popovers a click on the button
 * toggles a class the closed-state rule also reads. The `popover` property is never written: attributes only.
 */
export default function TopBar({ shell, project }: { shell: ShellData; project?: ReactNode }) {
  const pathname = usePathname();
  const home = orgHref(railOrgSlug(pathname, null, shell), '/dashboard');
  const barRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const lastPathname = useRef(pathname);
  // No state in the server markup: the mount sync and every toggle set it (L2-44 amended).
  const [expanded, setExpanded] = useState<boolean | undefined>(undefined);

  /** Places the panel's top edge at the bar's bottom edge (never above the viewport). */
  const placePanel = useCallback((panel: HTMLElement) => {
    if (barRef.current === null) return;
    panel.style.setProperty('--shell-panel-top', `${Math.max(0, barRef.current.getBoundingClientRect().bottom)}px`);
  }, []);

  /** Closes the panel if it is open, as a popover or by the fallback class. */
  const closePanel = useCallback(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    if (panel.classList.contains(OPEN_CLASS)) {
      panel.classList.remove(OPEN_CLASS);
      setExpanded(false);
    }
    if (typeof panel.hidePopover === 'function' && isPopoverOpen(panel)) panel.hidePopover();
  }, []);

  // At mount: take the panel's real state, which a press made before the scripts arrived may have opened (its toggle event
  // came before React), and close it when the viewport becomes 1024 px or wider. Nothing is closed here.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const open = isPopoverOpen(panel) || panel.classList.contains(OPEN_CLASS);
    if (open) placePanel(panel);
    setExpanded(open);
    const wide = window.matchMedia(WIDE);
    const onWide = (e: MediaQueryListEvent) => { if (e.matches) closePanel(); };
    wide.addEventListener('change', onWide);
    return () => wide.removeEventListener('change', onWide);
  }, [closePanel, placePanel]);

  // The address changed (back, forward, or a navigation from inside the page): close the panel over the new page.
  useEffect(() => {
    if (lastPathname.current === pathname) return;
    lastPathname.current = pathname;
    closePanel();
  }, [pathname, closePanel]);

  const onBeforeToggle = (e: ToggleEvent<HTMLDivElement>) => {
    if (e.newState === 'open') placePanel(e.currentTarget);
  };

  // Any press of a link inside the panel closes it, including one that keeps the pathname (Findings, the current item).
  const onPanelClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest('a[href]') !== null) closePanel();
  };

  const onMenuClick = () => {
    // Only where the browser has no popovers; elsewhere popovertarget does the work.
    if (Object.hasOwn(HTMLElement.prototype, 'popover')) return;
    const panel = panelRef.current;
    if (panel === null) return;
    placePanel(panel);
    setExpanded(panel.classList.toggle(OPEN_CLASS));
  };

  return (
    <>
      <header className="shell-topbar" ref={barRef}>
        <button type="button" className="shell-topbar__menu-button" popoverTarget={PANEL_ID} aria-controls={PANEL_ID}
          aria-expanded={expanded} onClick={onMenuClick}>
          <Icon name="menu" />
          {SHELL_COPY.menu}
        </button>
        {/* `/` only redirects (to the chooser, a gate or /login), so it is not prefetched, as in PublicHeader. */}
        <Link href={home} className="shell-topbar__brand" prefetch={home === '/' ? false : undefined}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a file already sized for the drawn logo (logos.ts). */}
          <img src={MAKAI_LOGO.src} srcSet={MAKAI_LOGO.srcSet} width={MAKAI_LOGO.width} height={MAKAI_LOGO.height}
            alt={PRODUCT_NAME} decoding="async" className="shell-topbar__logo" />
        </Link>
        {project ? <ShellPlace name="bar">{project}</ShellPlace> : null}
      </header>
      <div id={PANEL_ID} className="shell-topbar__panel" popover="auto" ref={panelRef} onClick={onPanelClick}
        onBeforeToggle={onBeforeToggle} onToggle={(e) => setExpanded(e.newState === 'open')}>
        <Rail shell={shell} project={project} />
      </div>
    </>
  );
}
