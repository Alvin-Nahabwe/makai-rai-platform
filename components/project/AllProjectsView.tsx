import type { ReactElement, ReactNode } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import { ButtonLink } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { UnarchiveProjectButton } from '@/components/project/UnarchiveProjectButton';
import type { ProjectRow } from '@/lib/data/projects';
import { PROJECT_COPY } from '@/lib/project/copy';

export type { ProjectRow } from '@/lib/data/projects';

const C = PROJECT_COPY.allProjects;

function Rows({ orgSlug, rows, unarchive, forFindings, empty }: { orgSlug: string; rows: ProjectRow[]; unarchive: boolean; forFindings: boolean; empty: string }): ReactElement {
  if (rows.length === 0) return <p>{empty}</p>;
  return (
    <ul className="projects-list">
      {rows.map((r) => (
        <li key={r.id}>
          <ListLink href={`/orgs/${orgSlug}/projects/${r.id}${forFindings ? '/findings' : ''}`}>{r.name}</ListLink>
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
 * every row link is a `ListLink` and the header's link a `ButtonLink`, neither of which prefetches (UX-37). With
 * `forFindings` (the rail's Findings link, plan 1A Task 12) the page says to choose a project, and every project links to
 * its findings page instead.
 */
export function AllProjectsView({ data, children }: {
  data: { orgSlug: string; canCreate?: boolean; canUnarchive: boolean; active: ProjectRow[]; archived: ProjectRow[]; forFindings?: boolean };
  children?: ReactNode;
}): ReactElement {
  const forFindings = data.forFindings === true;
  return (
    <div className="page-content">
      <PageHeader
        title={C.heading}
        lead={forFindings ? <p>{PROJECT_COPY.chooseForFindings}</p> : null}
        actions={data.canCreate === true ? <ButtonLink variant="primary" href={`/orgs/${data.orgSlug}/projects/new`}>{C.newProject}</ButtonLink> : null}
      />
      {/* tabIndex -1: an unarchived project moves here, and UnarchiveProjectButton sends focus to this heading (by its id,
          ACTIVE_HEADING_ID there) before the refresh that moves the row */}
      <section aria-labelledby="projects-active">
        <h2 id="projects-active" tabIndex={-1}>{C.active}</h2>
        <Rows orgSlug={data.orgSlug} rows={data.active} unarchive={false} forFindings={forFindings} empty={C.noActive} />
      </section>
      <section aria-labelledby="projects-archived">
        <h2 id="projects-archived">{C.archived}</h2>
        <Rows orgSlug={data.orgSlug} rows={data.archived} unarchive={data.canUnarchive} forFindings={forFindings} empty={C.noArchived} />
      </section>
      {children}
    </div>
  );
}
