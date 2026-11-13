import type { ReactElement, ReactNode } from 'react';
import { Breadcrumb } from '@/components/ui/Breadcrumb';
import type { BreadcrumbItem } from '@/components/ui/types';
import './Breadcrumb.css';
import './PageHeader.css';

export type PageHeaderProps = {
  breadcrumb?: readonly BreadcrumbItem[];
  title: string;
  /** The item's code, shown small after the title's words (voice rule 8), outside the <h1>. */
  code?: string;
  lead?: ReactNode;
  actions?: ReactNode;
};

/**
 * The top of a page (plan 1A Task 5): the breadcrumb, then the page's one <h1>, then its small code, then a lead and
 * the page's actions. The <h1> holds the title's words alone, so the heading's name is the title; the code follows it
 * as its own element. Every optional part is left out when not given. A server component: it has no handler of its own.
 */
export function PageHeader({ breadcrumb, title, code, lead, actions }: PageHeaderProps): ReactElement {
  return (
    <header className="ui-page-header">
      {breadcrumb === undefined ? null : <Breadcrumb items={breadcrumb} />}
      <div className="ui-page-header__heading">
        <h1 className="ui-page-header__title">{title}</h1>
        {code === undefined ? null : <p className="ui-page-header__code">{code}</p>}
      </div>
      {lead === undefined ? null : <div className="ui-page-header__lead">{lead}</div>}
      {actions === undefined ? null : <div className="ui-page-header__actions">{actions}</div>}
    </header>
  );
}
