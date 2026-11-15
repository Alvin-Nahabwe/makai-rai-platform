import type { Stage } from '@/types/record';
import type { ReactElement } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import { PROJECT_COPY } from '@/lib/project/copy';

const C = PROJECT_COPY.followUpCounts;

export type StageFollowUpCountsProps = { orgSlug: string; projectId: string; stage: Stage; counts: { openFindings: number; overdueMitigations: number } };

/**
 * The open-finding and overdue-mitigation counts of a stage (S-11; FR-FUP-01), each a link to
 * the list it counts: the findings list (S-14) and the stage's follow-up on the project page (S-10).
 */
export function StageFollowUpCounts({ orgSlug, projectId, stage, counts }: StageFollowUpCountsProps): ReactElement {
  const { openFindings, overdueMitigations } = counts;
  return (
    <p>
      <ListLink href={`/orgs/${orgSlug}/projects/${projectId}/findings`}>
        {`${openFindings} ${openFindings === 1 ? C.openFinding : C.openFindings}`}
      </ListLink>
      {', '}
      <ListLink href={`/orgs/${orgSlug}/projects/${projectId}#${stage}`}>
        {`${overdueMitigations} ${overdueMitigations === 1 ? C.overdueMitigation : C.overdueMitigations}`}
      </ListLink>
    </p>
  );
}
