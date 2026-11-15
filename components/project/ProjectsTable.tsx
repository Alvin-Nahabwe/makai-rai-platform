import type { ReactElement } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { ListLink } from '@/components/ui/ListLink';
import { Table, type TableColumn, type TableRow } from '@/components/ui/Table';
import { UnarchiveProjectButton } from '@/components/project/UnarchiveProjectButton';
import { PROJECTS_LIST_ID } from '@/components/project/projectsListId';
import type { ProjectRow } from '@/lib/data/projects';
import { PROJECT_COPY } from '@/lib/project/copy';
import { TERM_PROJECT } from '@/lib/vocabulary/terms';
import './ProjectsTable.css';

const C = PROJECT_COPY.allProjects;

type Key = 'project' | 'state' | 'actions';
export type ProjectsTableRow = ProjectRow & { archived: boolean };

/**
 * S-32, Projects (plan 1B Task 12; spec 8 "one list, active and archived", spec 7.5): one kit `Table` whose rows are the
 * item plate, the project's name as a link and then its descriptive line, with a State column ("Active", or "Archived"
 * beside the archive icon) and, for a person who may unarchive, an Actions column holding Unarchive on the archived rows.
 * The Actions column is left out when no row has an action, so a Viewer never sees a column of empty cells.
 *
 * Rule C8: active rows first, then archived ones, each group in the order given (listProjectRows reads the most recently
 * changed first); the headers do not sort, as a sort of one page of a paged list would mislead. Under 640 px of its own
 * width the kit's table becomes a card per project. With `target: 'findings'` (the rail's Findings link, plan 1A Task 12)
 * every row links to its project's findings page instead. Names and lines are rendered as React text only (NFR-SEC-11),
 * and every link is a `ListLink`, which never prefetches (UX-37). No project at all: the empty state, with no table.
 *
 * The list sits in an element with id `PROJECTS_LIST_ID`: Unarchive moves focus to the table's region inside it (named by
 * the caption) before the refresh that moves the unarchived row up among the active ones.
 */
export function ProjectsTable({ orgSlug, rows, canUnarchive, canCreate, target }: {
  orgSlug: string;
  rows: ReadonlyArray<ProjectsTableRow>;
  canUnarchive: boolean;
  canCreate: boolean;
  target: 'project' | 'findings';
}): ReactElement {
  if (rows.length === 0) {
    return (
      <EmptyState title={C.empty.title}>
        <p>{`${TERM_PROJECT.definition} ${canCreate ? C.empty.create : C.empty.ask}`}</p>
      </EmptyState>
    );
  }
  const ordered = [...rows.filter((r) => !r.archived), ...rows.filter((r) => r.archived)];
  const withActions = canUnarchive && ordered.some((r) => r.archived);
  const columns: TableColumn<Key>[] = [
    { key: 'project', label: C.columns.project },
    { key: 'state', label: C.columns.state },
    ...(withActions ? [{ key: 'actions', label: C.columns.actions, align: 'end' } as const] : []),
  ];
  const suffix = target === 'findings' ? '/findings' : '';
  const tableRows: TableRow<Key>[] = ordered.map((r) => ({
    key: r.id,
    cells: {
      project: (
        <>
          <ListLink className="projects-list__name" href={`/orgs/${orgSlug}/projects/${r.id}${suffix}`}>{r.name}</ListLink>
          {r.descriptiveLine === '' ? null : <p className="projects-list__line">{r.descriptiveLine}</p>}
        </>
      ),
      state: r.archived
        ? <span className="projects-list__state projects-list__state--archived"><Icon name="archive" size={16} />{C.archived}</span>
        : <span className="projects-list__state">{C.active}</span>,
      actions: withActions && r.archived ? <UnarchiveProjectButton orgSlug={orgSlug} projectId={r.id} projectName={r.name} /> : null,
    },
  }));
  return (
    <div id={PROJECTS_LIST_ID} className="projects-list">
      <Table caption={C.caption} columns={columns} rows={tableRows} rowHeaderKey="project" />
    </div>
  );
}
