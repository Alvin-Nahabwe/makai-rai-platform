import Link from 'next/link';
import type { ReactElement } from 'react';
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
 * Tabs as navigation (plan 1A Task 5, decision B9; modern-web-guidance `tabs` and `navbar`): each tab is an address, so
 * this is a labelled <nav> of links that stay in the tab order, never an ARIA tab list. The current one says
 * aria-current="page" and carries a 3 px underline (a shape, not a colour alone). The links are plain next/link, which
 * prefetches: a tab bar holds a few links, each a likely next page. The list keeps role="list" because Safari drops the
 * list role from a list styled `list-style: none`.
 */
export function TabNav({ label, items }: TabNavProps): ReactElement {
  return (
    <nav className="ui-tabnav" aria-label={label}>
      <ul className="ui-tabnav__list" role="list">
        {items.map((item) => (
          <li key={item.href}>
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
