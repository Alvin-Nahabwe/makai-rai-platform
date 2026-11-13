'use client';

import { useId, type ReactElement, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { SortDirection, SortWords } from '@/components/ui/types';
import { UI_COPY } from '@/lib/ui/copy';
import './Icon.css';
import './Table.css';

export type { SortDirection, SortWords } from '@/components/ui/types';

/**
 * A column is either not sortable (and has no words), or sortable with its words: "sortable without words" and "words
 * without sortable" do not type-check. `K` is the union of the column keys; written `as const` (or with `satisfies`),
 * the columns fix it, and the row cells, `rowHeaderKey` and `sort.key` are checked against it.
 */
export type TableColumn<K extends string = string> = { key: K; label: string; align?: 'start' | 'end' }
  & ({ sortable?: false; sortWords?: never } | { sortable: true; sortWords: SortWords });

/** One row: a cell for every column (pass `null` for a cell left empty). */
export type TableRow<K extends string = string> = { key: string; cells: Readonly<Record<K, ReactNode>> };
export type TableSort<K extends string = string> = { key: K; direction: SortDirection };

export type TableProps<K extends string = string> = {
  caption: string;
  captionHidden?: boolean;
  columns: ReadonlyArray<TableColumn<K>>;
  /** Rendered in the order given: the caller, which holds the data, sorts. */
  rows: ReadonlyArray<TableRow<NoInfer<K>>>;
  /** The column whose cell names its row (a `<th scope="row">`). The card layout takes it to be the first column. */
  rowHeaderKey: NoInfer<K>;
  sort?: TableSort<NoInfer<K>>;
  /** Called with a sortable column's key when its header is activated; the caller works out the direction. */
  onSort?: (key: NoInfer<K>) => void;
  /**
   * Shown after the table when there are no rows; `undefined`, `null` and `false` show nothing. A table with no rows
   * and no `empty` shows a bare header row, so every list screen passes one.
   */
  empty?: ReactNode;
};

/** The longest part of a caller's key a report quotes. */
const KEY_LIMIT = 40;
/**
 * A caller's key, cut to 40 characters and quoted as JSON: a quote, a backslash, a line feed and every other character
 * below U+0020 come out escaped. Later ones (U+007F, U+0085, U+2028, U+2029) are left as they are.
 */
const quoted = (key: string) => JSON.stringify(String(key).slice(0, KEY_LIMIT));
const DIRECTIONS: readonly string[] = ['ascending', 'descending'] satisfies readonly SortDirection[];

/**
 * A mistake in the calling screen. Outside production it throws, so a test or the development server shows it. In
 * production the table renders plainly (no sort state, no dead button) so a reader never meets a broken page, and the
 * mistake is reported with console.error: fixed words and the offending key, cut to 40 characters, never a cell's
 * content or the caption. A server render's report reaches the server's log; a browser's, its console.
 */
function mistake(message: string): void {
  if (process.env.NODE_ENV !== 'production') throw new Error(`Table: ${message}`);
  console.error(`Table: ${message}`);
}

const shown = (node: ReactNode) => node !== undefined && node !== null && node !== false;

/**
 * A data table (plan 1A Task 5; modern-web-guidance `responsive-table`, `sortable-table`). The wrapper is a region named
 * by the caption and focusable, so a keyboard can scroll it. A sortable header holds a button whose text is the column's
 * label alone; only the sorted header carries aria-sort; one visually hidden status line says the sort in the column's
 * own words, and is empty while nothing is sorted. Under a 640 px container the rows become cards (Table.css), each cell
 * showing its column's label, hidden from assistive technology; the explicit roles keep the table's semantics when the
 * cells are displayed as blocks. The table never sorts, fetches or logs a cell: it renders the rows given, keyed, so
 * React moves a row rather than rebuilding it, and reports a header's activation through `onSort`.
 *
 * The wrapper is a size container (its width does not come from its content), so place the table in a block or a
 * stretched cell, never in a shrink-to-fit parent (an inline-block, a float, a `width: max-content` box).
 */
export function Table<K extends string = string>({ caption, captionHidden = false, columns, rows, rowHeaderKey, sort, onSort, empty }: TableProps<K>): ReactElement {
  const captionId = useId();
  const canSort = onSort !== undefined;
  if (!canSort && columns.some((c) => c.sortable === true)) mistake('a column is sortable but no onSort was given');
  if (!columns.some((c) => c.key === rowHeaderKey)) mistake(`rowHeaderKey ${quoted(rowHeaderKey)} names no column`);
  else {
    const headless = rows.filter((row) => row.cells[rowHeaderKey] === undefined);
    if (headless.length > 0) mistake(`${headless.length} row(s) have no cell for the row header ${quoted(rowHeaderKey)}, the first ${quoted(headless[0].key)}`);
  }
  /** The sort shown (aria-sort and the status line): only a valid sort on a table whose header buttons exist. */
  let active: { column: Extract<TableColumn<K>, { sortable: true }>; direction: SortDirection } | undefined;
  if (sort !== undefined) {
    const column = columns.find((c) => c.key === sort.key);
    if (column === undefined) mistake(`sort.key ${quoted(sort.key)} names no column`);
    else if (column.sortable !== true) mistake(`sort.key ${quoted(sort.key)} names a column that is not sortable`);
    else if (!DIRECTIONS.includes(sort.direction)) mistake(`sort.direction ${quoted(sort.direction)} is not ascending or descending`);
    else if (canSort) active = { column, direction: sort.direction };
  }
  const endClass = (c: TableColumn<K>) => (c.align === 'end' ? 'ui-table__end' : undefined);

  return (
    <div className="ui-table-wrap" role="region" tabIndex={0} aria-labelledby={captionId}>
      <table className="ui-table" role="table">
        <caption id={captionId} className={captionHidden ? 'ui-table__caption visually-hidden' : 'ui-table__caption'}>{caption}</caption>
        <thead role="rowgroup">
          <tr role="row">
            {columns.map((column) => (
              <th key={column.key} role="columnheader" scope="col" className={endClass(column)}
                aria-sort={active?.column.key === column.key ? active.direction : undefined}>
                {column.sortable === true && canSort
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
      {rows.length === 0 && shown(empty) ? <div className="ui-table__empty">{empty}</div> : null}
      <p role="status" className="ui-table__status visually-hidden">
        {active === undefined ? '' : UI_COPY.table.sorted(active.column.label, active.column.sortWords[active.direction])}
      </p>
    </div>
  );
}
