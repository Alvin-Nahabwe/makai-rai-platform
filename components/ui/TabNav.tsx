'use client';

import Link from 'next/link';
import { useEffect, useRef, type ReactElement } from 'react';
import './TabNav.css';

export type TabNavItem = {
  /** An application path or query, passed to next/link as given: callers pass their own addresses. */
  href: string;
  label: string;
  /** A whole number, written in the link's own text after the label: "Open 13". Nothing sums the tabs. */
  count?: number;
  current: boolean;
};

export type TabNavProps = { label: string; items: readonly TabNavItem[] };

/**
 * Brings a tab wholly into view inside its own row, by the row's `scrollLeft` alone: never the page's scroll position,
 * never smoothly, and not at all when the tab is already wholly in view. The row's scroll padding is kept clear at both
 * ends, as the browser keeps it when it scrolls a focused tab into view. `scrollLeft` is a physical offset, so the same
 * arithmetic holds right to left.
 */
function reveal(list: HTMLElement, tab: Element): void {
  const row = list.getBoundingClientRect();
  const box = tab.getBoundingClientRect();
  // The row's scroll padding is a length here (TabNav.css); `auto` reads as NaN and means no padding.
  const padding = parseFloat(getComputedStyle(list).scrollPaddingInlineStart) || 0;
  // In view means clear of the scroll padding too: the row's box less the padding at each end.
  if (box.left < row.left + padding) list.scrollLeft += box.left - row.left - padding;
  else if (box.right > row.right - padding) list.scrollLeft += box.right - row.right + padding;
}

/**
 * Brings the focused tab into view when the focus ring is drawn (`:focus-visible`: focus from the keyboard), so the tab
 * and its ring are never cut by the row's edge. The browser's own scroll on focus is not enough: Chrome brings in a tab
 * that is wholly hidden and leaves one that already shows a strip of itself where it is. Focus from a pointer press draws
 * no ring and moves nothing: a row that moved under the pointer would put another tab beneath it before the release.
 */
function revealFocused(list: HTMLElement, focused: Element): void {
  if (focused.matches(':focus-visible')) reveal(list, focused);
}

/** Brings the current tab into view; with no tab current there is nothing to bring. */
function revealCurrent(list: HTMLElement): void {
  const tab = list.querySelector('[aria-current="page"]');
  if (tab !== null) reveal(list, tab);
}

/**
 * Tabs as navigation (plan 1A Task 5, decision B9; modern-web-guidance `tabs` and `navbar`): each tab is an address, so
 * this is a labelled <nav> of links that stay in the tab order, never an ARIA tab list. The current one says
 * aria-current="page" and carries a 3 px underline (a shape, not a colour alone). The tabs keep one row that scrolls
 * inside itself; an effect brings the current tab into view when the page opens, when its fonts arrive and when the tabs
 * change, and the row brings in a tab focused from the keyboard (a client component for those two alone: with no script
 * the row still scrolls by hand, and the browser's own scroll on focus still applies). The links are plain next/link,
 * which prefetches: a tab bar holds a few links, each a likely next page. The list keeps role="list" because Safari
 * drops the list role from a list styled `list-style: none`.
 */
export function TabNav({ label, items }: TabNavProps): ReactElement {
  const listRef = useRef<HTMLUListElement>(null);
  // What the row shows: a change in any tab's address, label, count or currency can move the current tab.
  const shape = items.map((item) => `${item.href}\u0000${item.label}\u0000${item.count ?? ''}\u0000${item.current}`).join('\u0001');
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    revealCurrent(list);
    // A web font that arrives later changes every tab's width: look again once the fonts are in. That second look
    // happens once, and it brings the current tab back into view even if the reader has moved the row by hand before
    // the fonts arrived.
    let live = true;
    void document.fonts.ready.then(() => { if (live) revealCurrent(list); });
    return () => { live = false; };
  }, [shape]);
  return (
    <nav className="ui-tabnav" aria-label={label}>
      <ul ref={listRef} className="ui-tabnav__list" role="list" onFocus={(event) => revealFocused(event.currentTarget, event.target)}>
        {items.map((item, i) => (
          <li key={`${i}-${item.href}`}>
            <Link className={item.current ? 'ui-tabnav__item ui-tabnav__item--current' : 'ui-tabnav__item'}
              aria-current={item.current ? 'page' : undefined} href={item.href}>
              {item.label}
              {item.count === undefined ? null : <>{' '}<span className="ui-tabnav__count">{item.count}</span></>}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
