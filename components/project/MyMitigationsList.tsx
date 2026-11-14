import '@/components/followup/FollowUp.css';
import type { ReactElement } from 'react';
import type { FollowUpItem } from '@/types/api';
import { ListLink } from '@/components/ui/ListLink';
import { formatDay } from '@/lib/format/dates';
import { STATUS_WORD } from '@/components/followup/StageFollowUp';
import { HOME_COPY } from '@/lib/home/copy';
import { PROJECT_COPY } from '@/lib/project/copy';

const F = PROJECT_COPY.followUp;

/**
 * The mitigations assigned to the signed-in person on S-08 (FR-PRJ-04; SRS 7.4.2 row S-08). Overdue is said in words:
 * the word "Overdue" alone is red (spec 7.1, never inside a status label), and ": was due <date>" is plain text after it
 * (UX-06, FR-FUP-02). A list with no total (UX-07).
 */
export function MyMitigationsList(p: { orgSlug: string; items: FollowUpItem[]; projectNames: Map<string, string> }): ReactElement {
  if (p.items.length === 0) return <p>{HOME_COPY.noMitigations}</p>;
  return (
    <ul>
      {p.items.map((i) => {
        const project = p.projectNames.get(i.projectId);
        return (
          <li key={i.mitigationId}>
            <span>{i.what ?? F.erased}</span>{' '}
            <span>{project === undefined ? '' : HOME_COPY.projectOf(project)}</span>{' '}
            <span className="status-label">{STATUS_WORD[i.status]}</span>{' '}
            {i.overdue ? (
              <span><span className="followup-overdue">{F.overdue}</span>{F.wasDue(formatDay(i.dueDate))}</span>
            ) : (
              <span>{F.due(formatDay(i.dueDate))}</span>
            )}{' '}
            <ListLink href={`/orgs/${p.orgSlug}/projects/${i.projectId}/findings/${i.findingId}`}>{F.view}</ListLink>
          </li>
        );
      })}
    </ul>
  );
}
