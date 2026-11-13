import type { ReactElement } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import type { BreadcrumbItem } from '@/components/ui/types';
import { UI_COPY } from '@/lib/ui/copy';
import './Breadcrumb.css';

export type BreadcrumbProps = {
  /** The last item is the current page. Each `href` is an application path, passed to the link as given. */
  items: readonly BreadcrumbItem[];
};

/**
 * Where this page sits (plan 1A Task 5): a <nav> named "Breadcrumb" holding an ordered list. The last item is the
 * current page and the only one with aria-current="page": text, or a link to the page when the caller gives it an
 * address. The separator is drawn by CSS from borders, with no text, so nothing is read between the items. The links
 * never prefetch (ListLink): a breadcrumb sits on every page header, and prefetching its ancestors on each view would
 * render pages nobody opens. With no items it renders nothing: an empty navigation landmark would only be noise.
 */
export function Breadcrumb({ items }: BreadcrumbProps): ReactElement | null {
  if (items.length === 0) return null;
  const last = items.length - 1;
  return (
    <nav className="ui-breadcrumb" aria-label={UI_COPY.breadcrumbLabel}>
      <ol className="ui-breadcrumb__list" role="list">
        {items.map((item, i) => {
          const className = i === last ? 'ui-breadcrumb__current' : undefined;
          const ariaCurrent = i === last ? 'page' : undefined;
          return (
            <li key={`${i}-${item.label}`} className="ui-breadcrumb__item">
              {item.href === undefined
                ? <span className={className} aria-current={ariaCurrent}>{item.label}</span>
                : <ListLink className={className} aria-current={ariaCurrent} href={item.href}>{item.label}</ListLink>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
