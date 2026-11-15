import type { ReactElement } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import { Icon } from '@/components/ui/Icon';
import { ArchiveProjectControl } from '@/components/project/ArchiveProjectControl';
import type { ProjectActions as Can } from '@/lib/projects/can';
import { PROJECT_COPY } from '@/lib/project/copy';

const P = PROJECT_COPY;

/**
 * S-10's quiet "This project" row (the sketch's nav.acts; spec 9.2, 7.5): Findings, Download records and Edit project
 * details, each only when the role allows it (`can`, lib/projects/can.ts), then Archive last, in a slot of its own pushed
 * to the far end, never beside the primary action (which sits on a stage's line) and in the same order on every width.
 *
 * Mount stability (ArchiveProjectControl's status line and its focus survive the router.refresh() after an archive):
 * the row renders for every role, its children keep fixed places (conditional slots are `cond ? x : null`), and the
 * archive slot's condition, `can.archiveControl`, follows the role alone, so the live and the archived pages give the
 * control the same place in the tree (__tests__/unit/project-page.test.tsx, "mount stability").
 *
 * "Reviews and documents" waits for stage 2 (designer's ruling): no page serves it, so no link.
 */
export function ProjectActions({ base, can, orgSlug, projectId, projectName, archived }: {
  base: string; can: Can; orgSlug: string; projectId: string; projectName: string; archived: boolean;
}): ReactElement {
  return (
    <nav className="project-actions" aria-labelledby="project-actions-heading">
      <h2 id="project-actions-heading">{P.thisProject}</h2>
      <ul className="project-actions__list" role="list">
        <li><ListLink href={`${base}/findings`}><Icon name="flag" size={18} />{P.findings}</ListLink></li>
        {can.export ? <li><ListLink href={`${base}/export`}><Icon name="download" size={18} />{P.overview.downloadRecords}</ListLink></li> : null}
        {can.update ? <li><ListLink href={`${base}/edit`}><Icon name="pencil" size={18} />{P.editProjectDetails}</ListLink></li> : null}
      </ul>
      {can.archiveControl ? (
        <div className="project-actions__archive">
          <ArchiveProjectControl orgSlug={orgSlug} projectId={projectId} projectName={projectName} archived={archived} />
        </div>
      ) : null}
    </nav>
  );
}
