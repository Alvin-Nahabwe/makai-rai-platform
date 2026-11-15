import type { ReactElement, ReactNode } from 'react';
import { Breadcrumb } from '@/components/ui/Breadcrumb';
import type { BreadcrumbItem } from '@/components/ui/types';
import { markTerms, usesTerm } from '@/components/review/markTerms';
import { TermList, termListId } from '@/components/review/TermList';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import '@/components/ui/pageHeaderStyles';

export type ReviewPageHeaderProps = {
  breadcrumb: readonly BreadcrumbItem[];
  title: string;
  /** Terms the title may hold: each one it uses is marked in the `h1` and defined in the list under it. */
  titleTerms: readonly DefinedEntry[];
  /** Terms the page uses later and first introduces here: each is marked in the list itself. */
  moreTerms?: readonly DefinedEntry[];
  lead?: ReactNode;
  /** Prefix of the definitions' ids, unique on the page. */
  idPrefix: string;
};

/**
 * The top of the stage review screens with their first-use definitions (spec 6; lane 6, B4): the kit's page header
 * (components/ui/PageHeader.tsx, the same classes and order) with two differences. The `h1` marks the terms its title
 * holds with `Term` and names their definitions with `aria-describedby`; and a `TermList` under the heading holds those
 * definitions, then the `moreTerms`. The kit's `PageHeader` takes its title as plain text and has no place for the
 * list, so these screens draw the header themselves until it does.
 */
export function ReviewPageHeader({ breadcrumb, title, titleTerms, moreTerms = [], lead, idPrefix }: ReviewPageHeaderProps): ReactElement {
  const inTitle = titleTerms.filter((t) => usesTerm(title, t));
  const describedBy = inTitle.map((t) => termListId(idPrefix, t)).join(' ');
  return (
    <header className="ui-page-header">
      <Breadcrumb items={breadcrumb} />
      <div className="ui-page-header__heading">
        <h1 className="ui-page-header__title" aria-describedby={describedBy === '' ? undefined : describedBy}>{markTerms(title, inTitle)}</h1>
      </div>
      <TermList idPrefix={idPrefix} items={[...inTitle.map((of) => ({ of, marked: false })), ...moreTerms.map((of) => ({ of, marked: true }))]} />
      {lead === undefined || lead === null ? null : <div className="ui-page-header__lead">{lead}</div>}
    </header>
  );
}
