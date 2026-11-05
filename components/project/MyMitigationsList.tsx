import type { ReactElement } from 'react';
import type { FollowUpItem } from '@/types/api';
import { ListLink } from '@/components/ui/ListLink';
import { formatDay } from '@/lib/format/dates';
import { STATUS_WORD } from '@/components/followup/StageFollowUp';

/**
 * The signed-in person's open and overdue mitigations on S-08 (FR-PRJ-04; SRS 7.4.2 row S-08). Overdue is said in words:
 * the tint wraps the word "Overdue" alone, and ": was due <date>" is plain text after it (UX-06, FR-FUP-02). A list
 * with no total (UX-07).
 */
export function MyMitigationsList(p: { orgSlug: string; items: FollowUpItem[]; projectNames: Map<string, string> }): ReactElement {
  if (p.items.length === 0) return <p>You own no open mitigations.</p>;
  return (
    <ul>
      {p.items.map((i) => (
        <li key={i.mitigationId}>
          <span>{i.what ?? 'No text recorded.'}</span>{' '}
          <span>{p.projectNames.get(i.projectId) ?? ''}</span>{' '}
          <span className="status-label">{STATUS_WORD[i.status]}</span>{' '}
          {i.overdue ? (
            <span><span className="status-label status-label--warning badge--moderate">Overdue</span>{`: was due ${formatDay(i.dueDate)}`}</span>
          ) : (
            <span>{`Due ${formatDay(i.dueDate)}`}</span>
          )}{' '}
          <ListLink href={`/orgs/${p.orgSlug}/projects/${i.projectId}/findings/${i.findingId}`}>Open</ListLink>
        </li>
      ))}
    </ul>
  );
}
