import type { ReactElement } from 'react';
import type { FollowUpItem } from '@/types/api';
import type { HomeBase } from '@/lib/home/types';
import { HOME_COPY } from '@/lib/home/copy';
import { PROJECT_COPY } from '@/lib/project/copy';
import { formatDay } from '@/lib/format/dates';
import { ListLink } from '@/components/ui/ListLink';
import { STATUS_WORD } from '@/components/followup/StageFollowUp';
import type { FirstUses } from '@/components/home/firstUse';
import { Defs, MetaLine, OverdueWord, SLOT, StageName, TermList, personName, projectNameIfMany, withSlot } from '@/components/home/parts';

const F = PROJECT_COPY.followUp;

/**
 * One mitigation as a plate: its words as the link to its finding, then one line of state: its status, its due date (the
 * word "Overdue" red and the date after it plain, spec 7.1), who it is assigned to when that is not the reader, its stage,
 * and its project when the organisation has more than one. A mitigation whose text was erased says so. `where` is the
 * plate's place for first uses (the stage's definition follows the line when this is its first use).
 */
export function MitigationPlate({ base, item, showAssignee, uses, where }: {
  base: HomeBase; item: FollowUpItem; showAssignee: boolean; uses: FirstUses; where: string;
}): ReactElement {
  const project = projectNameIfMany(base, item.projectId);
  return (
    <li className="home-plate">
      <ListLink className="home-plate__title" href={`/orgs/${base.orgSlug}/projects/${item.projectId}/findings/${item.findingId}`}>
        {item.what === null ? F.erased : <bdi>{item.what}</bdi>}
      </ListLink>
      <MetaLine parts={[
        showAssignee ? withSlot(F.assignedTo(SLOT), personName(item.owner)) : <span className="home-plate__status">{STATUS_WORD[item.status]}</span>,
        item.overdue ? <><OverdueWord />{F.wasDue(formatDay(item.dueDate))}</> : F.due(formatDay(item.dueDate)),
        <StageName key="stage" stage={item.stage} />,
        project === null ? null : <bdi>{project}</bdi>,
      ]} />
      <Defs uses={uses} where={where} />
    </li>
  );
}

/**
 * Spec 9.1 (3): the mitigations assigned to the reader, with their due dates, under the definitions the sketch puts there
 * (when this is their first use). A person who records always has the section ("No mitigations are assigned to you." when
 * empty); a Reviewer or Viewer has it only when something is assigned to them (lane lead, fix round 1).
 */
export function AssignedToYou({ base, items, uses }: { base: HomeBase; items: readonly FollowUpItem[]; uses: FirstUses }): ReactElement {
  return (
    <section className="home-section">
      <h2>{HOME_COPY.assignedHeading}</h2>
      <TermList uses={uses} where="terms:assigned" />
      {items.length === 0
        ? <p className="home-empty">{HOME_COPY.assignedNone}</p>
        : (
          <ul className="home-plates" role="list">
            {items.map((i) => <MitigationPlate key={i.mitigationId} base={base} item={i} showAssignee={false} uses={uses} where={`assigned:${i.mitigationId}`} />)}
          </ul>
        )}
    </section>
  );
}
