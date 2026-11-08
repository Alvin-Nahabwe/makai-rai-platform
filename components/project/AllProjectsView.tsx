import type { ReactElement, ReactNode } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import { UnarchiveProjectButton } from '@/components/project/UnarchiveProjectButton';
import type { ProjectRow } from '@/lib/data/projects';

export type { ProjectRow } from '@/lib/data/projects';

function Rows({ orgSlug, rows, unarchive }: { orgSlug: string; rows: ProjectRow[]; unarchive: boolean }): ReactElement {
  if (rows.length === 0) return <p>None.</p>;
  return (
    <ul className="projects-list">
      {rows.map((r) => (
        <li key={r.id}>
          <ListLink href={`/orgs/${orgSlug}/projects/${r.id}`}>{r.name}</ListLink>
          {r.descriptiveLine !== '' ? <span className="text-muted">{` ${r.descriptiveLine}`}</span> : null}
          {unarchive ? <>{' '}<UnarchiveProjectButton orgSlug={orgSlug} projectId={r.id} projectName={r.name} /></> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * S-32, all projects (FR-PRJ-03; SRS S-32 row): active ones, then archived ones, each with a link to S-10; an archived row has
 * Unarchive for owners and admins. `children` is rendered once, after both lists (the "Show more" link). A long list, so
 * every link is a `ListLink` that never prefetches (UX-37).
 */
export function AllProjectsView({ data, children }: {
  data: { orgSlug: string; canCreate?: boolean; canUnarchive: boolean; active: ProjectRow[]; archived: ProjectRow[] };
  children?: ReactNode;
}): ReactElement {
  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>All projects</h1>
        </div>
        {data.canCreate === true ? <ListLink href={`/orgs/${data.orgSlug}/projects/new`} className="btn btn--primary">New project</ListLink> : null}
      </div>
      <section aria-labelledby="projects-active">
        <h2 id="projects-active">Active</h2>
        <Rows orgSlug={data.orgSlug} rows={data.active} unarchive={false} />
      </section>
      <section aria-labelledby="projects-archived">
        <h2 id="projects-archived">Archived</h2>
        <Rows orgSlug={data.orgSlug} rows={data.archived} unarchive={data.canUnarchive} />
      </section>
      {children}
    </div>
  );
}
