'use client';

import { useEffect, useRef, useState, type ToggleEvent } from 'react';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import Rail from '@/components/layout/Rail';
import { SHELL_COPY } from '@/lib/shell/copy';
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
 * Below 1024 px the bar shows the product name and a Menu button; the button opens the panel natively with popovertarget,
 * with JavaScript or without it, and the browser closes it on Escape or a press outside and returns focus. From 1024 px CSS
 * hides the bar and shows the panel in the rail's column, open or not (components/layout/shell.css).
 *
 * With JavaScript the bar also: mirrors the panel's state into the button's aria-expanded; places the panel's top edge at the
 * bar's bottom edge as it opens (no anchor positioning); closes the panel when the address changes, since the layout outlives
 * a client navigation; closes it when the viewport reaches 1024 px. In a browser without popovers a click on the button
 * toggles a class the closed-state rule also reads. The `popover` property is never written: attributes only.
 */
export default function TopBar({ shell, title }: { shell: ShellData; title: string }) {
  const pathname = usePathname();
  const barRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);

  // Closing is a no-op when the panel is already closed, so these effects may run at mount.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const close = () => {
      if (panel.classList.contains(OPEN_CLASS)) {
        panel.classList.remove(OPEN_CLASS);
        setExpanded(false);
      }
      if (typeof panel.hidePopover === 'function' && isPopoverOpen(panel)) panel.hidePopover();
    };
    close();
    const wide = window.matchMedia(WIDE);
    const onWide = (e: MediaQueryListEvent) => { if (e.matches) close(); };
    wide.addEventListener('change', onWide);
    return () => wide.removeEventListener('change', onWide);
  }, [pathname]);

  const onBeforeToggle = (e: ToggleEvent<HTMLDivElement>) => {
    if (e.newState !== 'open' || barRef.current === null) return;
    const top = Math.max(0, barRef.current.getBoundingClientRect().bottom);
    e.currentTarget.style.setProperty('--shell-panel-top', `${top}px`);
  };

  const onMenuClick = () => {
    // Only where the browser has no popovers; elsewhere popovertarget does the work.
    if (Object.hasOwn(HTMLElement.prototype, 'popover')) return;
    const panel = panelRef.current;
    if (panel === null || barRef.current === null) return;
    panel.style.setProperty('--shell-panel-top', `${Math.max(0, barRef.current.getBoundingClientRect().bottom)}px`);
    setExpanded(panel.classList.toggle(OPEN_CLASS));
  };

  return (
    <>
      <header className="shell-topbar" ref={barRef}>
        <span className="shell-topbar__title">{title}</span>
        <button type="button" className="shell-topbar__menu-button" popoverTarget={PANEL_ID} aria-controls={PANEL_ID}
          aria-expanded={expanded} onClick={onMenuClick}>
          <Icon name="menu" />
          {SHELL_COPY.menu}
        </button>
      </header>
      <div id={PANEL_ID} className="shell-topbar__panel" popover="auto" ref={panelRef}
        onBeforeToggle={onBeforeToggle} onToggle={(e) => setExpanded(e.newState === 'open')}>
        <Rail shell={shell} />
      </div>
    </>
  );
}
