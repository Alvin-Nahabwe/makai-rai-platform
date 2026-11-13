'use client';

import { useId, type ReactElement, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { UI_COPY } from '@/lib/ui/copy';
import './Icon.css';
import './Table.css';

/**
 * The two phrases a sortable column is announced with, keyed by aria-sort's two values: the owner's decision of 13
 * November 2026, "Words that fit the column". The common pairs are `SORT_WORDS` in lib/ui/copy.ts.
 */
export type SortWords = { readonly ascending: string; readonly descending: string };
export type SortDirection = 'ascending' | 'descending';

/** A column is either not sortable, or sortable with its words: "sortable without words" does not type-check. */
export type TableColumn = { key: string; label: string; align?: 'start' | 'end' }
  & ({ sortable?: false } | { sortable: true; sortWords: SortWords });

export type TableRow = { key: string; cells: Readonly<Record<string, ReactNode>> };
export type TableSort = { key: string; direction: SortDirection };

export type TableProps = {
  caption: string;
  captionHidden?: boolean;
  columns: readonly TableColumn[];
  /** Rendered in the order given: the caller, which holds the data, sorts. */
  rows: readonly TableRow[];
  /** The column whose cell names its row (a `<th scope="row">`). */
  rowHeaderKey: string;
  sort?: TableSort;
  /** Called with a sortable column's key when its header is activated; the caller works out the direction. */
  onSort?: (key: string) => void;
  /** Shown after the table when there are no rows. */
  empty?: ReactNode;
};

type SortableColumn = Extract<TableColumn, { sortable: true }>;

/**
 * A mistake in the calling screen. Outside production it throws, so a test or the development server shows it; in
 * production the table renders plainly (no sort state, no dead button) so a reader never meets a broken page. The same
 * rule as Definition (components/ui/Definition.tsx).
 */
function mistake(message: string): void {
  if (process.env.NODE_ENV !== 'production') throw new Error(`Table: ${message}`);
}

/**
 * A data table (plan 1A Task 5; modern-web-guidance `responsive-table`, `sortable-table`). The wrapper is a region named
 * by the caption and focusable, so a keyboard can scroll it. A sortable header holds a button whose text is the column's
 * label alone; only the sorted header carries aria-sort; one visually hidden status line says the sort in the column's
 * own words, and is empty while nothing is sorted. Under a 640 px container the rows become cards (Table.css), each cell
 * showing its column's label, hidden from assistive technology; the explicit roles keep the table's semantics when the
 * cells are displayed as blocks. The table never sorts, fetches or logs: it renders the rows given, keyed, so React moves
 * a row rather than rebuilding it, and reports a header's activation through `onSort`.
 */
export function Table({ caption, captionHidden = false, columns, rows, rowHeaderKey, sort, onSort, empty }: TableProps): ReactElement {
  const captionId = useId();
  if (!columns.some((c) => c.key === rowHeaderKey)) mistake(`rowHeaderKey "${rowHeaderKey}" names no column`);
  let sorted: SortableColumn | undefined;
  if (sort !== undefined) {
    const column = columns.find((c) => c.key === sort.key);
    if (column === undefined) mistake(`sort.key "${sort.key}" names no column`);
    else if (column.sortable === true) sorted = column;
    else mistake(`sort.key "${sort.key}" names a column that is not sortable`);
  }
  if (onSort === undefined && columns.some((c) => c.sortable === true)) mistake('a column is sortable but no onSort was given');
  for (const row of rows) {
    if (row.cells[rowHeaderKey] === undefined) mistake(`row "${row.key}" has no cell for its row header "${rowHeaderKey}"`);
  }
  const endClass = (c: TableColumn) => (c.align === 'end' ? 'ui-table__end' : undefined);

  return (
    <div className="ui-table-wrap" role="region" tabIndex={0} aria-labelledby={captionId}>
      <table className="ui-table" role="table">
        <caption id={captionId} className={captionHidden ? 'ui-table__caption visually-hidden' : 'ui-table__caption'}>{caption}</caption>
        <thead role="rowgroup">
          <tr role="row">
            {columns.map((column) => (
              <th key={column.key} role="columnheader" scope="col" className={endClass(column)}
                aria-sort={sorted !== undefined && sort !== undefined && sorted.key === column.key ? sort.direction : undefined}>
                {column.sortable === true && onSort !== undefined
                  ? (
                    <button type="button" className="ui-table__sort" onClick={() => onSort(column.key)}>
                      {column.label}
                      <span className="ui-table__sort-icon">
                        <Icon name="chevrons-up-down" size={16} />
                        <Icon name="arrow-up" size={16} />
                      </span>
                    </button>
                  )
                  : column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row) => (
            <tr key={row.key} role="row">
              {columns.map((column) => (column.key === rowHeaderKey
                ? <th key={column.key} role="rowheader" scope="row" className={endClass(column)}>{row.cells[column.key]}</th>
                : (
                  <td key={column.key} role="cell" className={endClass(column)}>
                    <span className="ui-table__cell-label" aria-hidden="true">{column.label}</span>
                    {row.cells[column.key]}
                  </td>
                )))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && empty !== undefined ? <div className="ui-table__empty">{empty}</div> : null}
      <p role="status" className="ui-table__status visually-hidden">
        {sorted !== undefined && sort !== undefined ? UI_COPY.table.sorted(sorted.label, sorted.sortWords[sort.direction]) : ''}
      </p>
    </div>
  );
}
