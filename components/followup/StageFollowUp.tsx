import type { Stage } from '@/types/record';
import type { FollowUpItem } from '@/types/api';
import type { ReactElement } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import { formatDay } from '@/lib/format/dates';

export type StageFollowUpProps = { orgSlug: string; projectId: string; stage: Stage; items: FollowUpItem[]; cannotAct: FollowUpItem[] };

const STATUS_WORD = { planned: 'Planned', in_progress: 'In progress' } as const;

/** Overdue first, then due date, then mitigation id (FR-FUP-01); an item that is in both lists once. */
function ordered(items: FollowUpItem[], cannotAct: FollowUpItem[]): FollowUpItem[] {
  const byId = new Map<string, FollowUpItem>();
  for (const i of [...items, ...cannotAct]) byId.set(i.mitigationId, i);
  return [...byId.values()].sort((a, b) =>
    Number(b.overdue) - Number(a.overdue)
    || (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0)
    || (a.mitigationId < b.mitigationId ? -1 : a.mitigationId > b.mitigationId ? 1 : 0));
}

/**
 * The follow-up of one stage on the project page (S-10; FR-FUP-01, 02, 05). Overdue and "owner
 * cannot act" are said in words and tinted (UX-06); the tint is never the only signal.
 */
export function StageFollowUp({ orgSlug, projectId, stage, items, cannotAct }: StageFollowUpProps): ReactElement {
  const all = ordered(items, cannotAct);
  return (
    <section aria-labelledby={`follow-up-${stage}`}>
      <h4 id={`follow-up-${stage}`}>Mitigations to follow up</h4>
      {all.length === 0 ? (
        <p>None open.</p>
      ) : (
        <ul>
          {all.map((i) => (
            <li key={i.mitigationId}>
              <span>{i.what ?? ''}</span>{' '}
              <span>{i.owner.name}</span>{' '}
              <span data-status-label>{STATUS_WORD[i.status]}</span>{' '}
              {i.overdue ? (
                <span className="badge--moderate">Overdue: was due {formatDay(i.dueDate)}</span>
              ) : (
                <span>Due {formatDay(i.dueDate)}</span>
              )}
              {!i.ownerCanAct ? <>{' '}<span className="badge--moderate">Owner cannot act: reassign</span></> : null}
              {' '}
              <ListLink href={`/orgs/${orgSlug}/projects/${projectId}/findings/${i.findingId}`}>Open</ListLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
