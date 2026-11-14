import type { Stage } from '@/types/record';
import type { FollowUpItem } from '@/types/api';
import './FollowUp.css';
import type { ReactElement } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import { formatDay } from '@/lib/format/dates';
import { compareFollowUp } from '@/lib/followup/rules';
import { PROJECT_COPY } from '@/lib/project/copy';

export type StageFollowUpProps = { orgSlug: string; projectId: string; stage: Stage; items: FollowUpItem[]; cannotAct: FollowUpItem[] };

/**
 * The mitigation status words (SRS 5.3 item 11); the claims crawl exempts exactly these inside .status-label. They stay
 * in this file, not in a copy module: __tests__/lint/claim-allowlist.json allows "In progress" in this file's source.
 */
export const STATUS_WORD = { planned: 'Planned', in_progress: 'In progress' } as const;

/** The order of FR-FUP-01; an item that is in both lists is shown once. */
function ordered(items: FollowUpItem[], cannotAct: FollowUpItem[]): FollowUpItem[] {
  const byId = new Map<string, FollowUpItem>();
  for (const i of [...items, ...cannotAct]) byId.set(i.mitigationId, i);
  return [...byId.values()].sort(compareFollowUp);
}

const F = PROJECT_COPY.followUp;

/**
 * The follow-up of one stage on the project page (S-10; FR-FUP-01, 02, 05). Overdue and an owner who cannot act are said
 * in words (UX-06): the word Overdue alone is red (spec 7.1, never inside a status label) with ": was due <date>" plain
 * after it; the owner who cannot act is a plain sentence naming them (not a status label: ruling L5-5 amended), followed
 * by what to do.
 */
export function StageFollowUp({ orgSlug, projectId, stage, items, cannotAct }: StageFollowUpProps): ReactElement {
  const all = ordered(items, cannotAct);
  return (
    <section aria-labelledby={`follow-up-${stage}`}>
      <h4 id={`follow-up-${stage}`}>{F.heading}</h4>
      {all.length === 0 ? (
        <p>{F.none}</p>
      ) : (
        <ul>
          {all.map((i) => (
            <li key={i.mitigationId}>
              <span>{i.what ?? F.erased}</span>{' '}
              <span>{F.assignedTo(i.owner.name)}</span>{' '}
              <span className="status-label">{STATUS_WORD[i.status]}</span>{' '}
              {i.overdue ? (
                <span><span className="followup-overdue">{F.overdue}</span>{F.wasDue(formatDay(i.dueDate))}</span>
              ) : (
                <span>{F.due(formatDay(i.dueDate))}</span>
              )}
              {!i.ownerCanAct ? <>{' '}<span>{F.cannotAct(i.owner.name)}{' '}{F.reassign}</span></> : null}
              {' '}
              <ListLink href={`/orgs/${orgSlug}/projects/${projectId}/findings/${i.findingId}`}>{F.view}</ListLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
