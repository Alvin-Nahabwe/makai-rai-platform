'use client';

import { useState, type ReactElement } from 'react';
import { Table, type TableColumn, type TableSort } from '@/components/ui/Table';
import { SORT_WORDS } from '@/lib/ui/copy';

/**
 * The gallery's sortable table (plan 1A Task 5). The Table sorts nothing: like a real screen, this demo holds the rows,
 * works out the direction (a new column starts A to Z or earliest first; the same column again turns it round) and
 * hands the Table the rows in order. Sample data only; nothing is sent anywhere.
 */

type Finding = { id: string; name: string; stage: string; opened: string; openedLabel: string; files: number };

const FINDINGS: readonly Finding[] = [
  { id: 'f1', name: 'Consent does not cover reuse of the sample data', stage: 'Pre-processing', opened: '2026-02-11', openedLabel: '11 Feb 2026', files: 2 },
  { id: 'f2', name: 'Retention period is not set', stage: 'Pre-processing', opened: '2026-03-03', openedLabel: '3 Mar 2026', files: 0 },
  { id: 'f3', name: 'Bias check on the triage model is pending', stage: 'In processing', opened: '2026-01-20', openedLabel: '20 Jan 2026', files: 5 },
  { id: 'f4', name: 'Appeal route for patients is unclear', stage: 'Post-processing', opened: '2026-04-08', openedLabel: '8 Apr 2026', files: 1 },
];

/** Written `as const` and checked with `satisfies`, so the Table infers the column keys and checks every key below. */
const FINDING_COLUMNS = [
  { key: 'finding', label: 'Finding', sortable: true, sortWords: SORT_WORDS.name },
  { key: 'stage', label: 'Stage' },
  { key: 'opened', label: 'Opened', sortable: true, sortWords: SORT_WORDS.date },
  { key: 'files', label: 'Evidence files', align: 'end', sortable: true, sortWords: SORT_WORDS.number },
] as const satisfies readonly TableColumn[];

type FindingKey = (typeof FINDING_COLUMNS)[number]['key'];
type SortKey = Extract<(typeof FINDING_COLUMNS)[number], { sortable: true }>['key'];

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** One comparison per sortable column: a sortable column added above without one here does not compile. */
const COMPARE: Readonly<Record<SortKey, (a: Finding, b: Finding) => number>> = {
  finding: (a, b) => collator.compare(a.name, b.name),
  opened: (a, b) => a.opened.localeCompare(b.opened),
  files: (a, b) => a.files - b.files,
};

const isSortKey = (key: FindingKey): key is SortKey => Object.hasOwn(COMPARE, key);

/** The order a key and direction give; equal rows keep their order (Array.prototype.sort is stable). */
function sorted(rows: readonly Finding[], sort: TableSort<SortKey> | undefined): readonly Finding[] {
  if (sort === undefined) return rows;
  const factor = sort.direction === 'ascending' ? 1 : -1;
  return [...rows].sort((a, b) => factor * COMPARE[sort.key](a, b));
}

export function SortableTableDemo(): ReactElement {
  const [sort, setSort] = useState<TableSort<SortKey> | undefined>(undefined);
  const onSort = (key: FindingKey) => {
    // The Table calls onSort only from a sortable column's button, so any other key is a mistake in this demo.
    if (!isSortKey(key)) throw new Error(`StructureDemos: "${key}" is not a sortable column`);
    setSort((now) => (now?.key === key
      ? { key, direction: now.direction === 'ascending' ? 'descending' : 'ascending' }
      : { key, direction: 'ascending' }));
  };
  return (
    <div data-demo="sortable-table">
      <Table caption="Sample findings" columns={FINDING_COLUMNS} rowHeaderKey="finding" sort={sort} onSort={onSort}
        rows={sorted(FINDINGS, sort).map((f) => ({
          key: f.id,
          cells: { finding: f.name, stage: f.stage, opened: <time dateTime={f.opened}>{f.openedLabel}</time>, files: f.files },
        }))} />
    </div>
  );
}
