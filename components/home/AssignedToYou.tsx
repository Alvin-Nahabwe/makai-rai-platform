import type { ReactElement } from 'react';
import type { FollowUpItem } from '@/types/api';
import type { HomeBase } from '@/lib/home/types';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import { HOME_COPY } from '@/lib/home/copy';
import { PROJECT_COPY } from '@/lib/project/copy';
import { formatDay } from '@/lib/format/dates';
import { TERM_FINDING, TERM_MITIGATION } from '@/lib/vocabulary/terms';
import { ListLink } from '@/components/ui/ListLink';
import { Definition, Term } from '@/components/ui/Definition';
import { STATUS_WORD } from '@/components/followup/StageFollowUp';
import { STAGE_NAME } from '@/components/project/StageColumn';
import { MetaLine, OverdueWord, SLOT, personName, projectNameIfMany, withSlot } from '@/components/home/parts';

const F = PROJECT_COPY.followUp;

/**
 * Terms with their definitions, as a short list under a heading (spec 6: the definition sits beside the term's first use;
 * the sketch defines "mitigation" and "finding" under "Assigned to you"). Each term is a <dt> marked with `Term`, its
 * definition the <dd> right after it.
 */
export function TermList({ terms }: { terms: readonly { entry: DefinedEntry; word: string }[] }): ReactElement {
  return (
    <dl className="home-terms">
      {terms.map(({ entry, word }) => (
        <div key={entry.id} className="home-terms__pair">
          <dt><Term of={entry}>{word}</Term></dt>
          <dd><Definition of={entry} /></dd>
        </div>
      ))}
    </dl>
  );
}

/** "Mitigation" and "Finding", the two words Home's lists are made of. */
export const FOLLOW_UP_TERMS = [{ entry: TERM_MITIGATION, word: 'Mitigation' }, { entry: TERM_FINDING, word: 'Finding' }] as const;

/**
 * One mitigation as a plate: its words as the link to its finding, then one line of state: its status, its due date (the
 * word "Overdue" red and the date after it plain, spec 7.1), who it is assigned to when that is not the reader, its stage,
 * and its project when the organisation has more than one. A mitigation whose text was erased says so.
 */
export function MitigationPlate({ base, item, showAssignee }: { base: HomeBase; item: FollowUpItem; showAssignee: boolean }): ReactElement {
  const project = projectNameIfMany(base, item.projectId);
  return (
    <li className="home-plate">
      <ListLink className="home-plate__title" href={`/orgs/${base.orgSlug}/projects/${item.projectId}/findings/${item.findingId}`}>
        {item.what === null ? F.erased : <bdi>{item.what}</bdi>}
      </ListLink>
      <MetaLine parts={[
        showAssignee ? withSlot(F.assignedTo(SLOT), personName(item.owner)) : <span className="home-plate__status">{STATUS_WORD[item.status]}</span>,
        item.overdue ? <><OverdueWord />{F.wasDue(formatDay(item.dueDate))}</> : F.due(formatDay(item.dueDate)),
        STAGE_NAME[item.stage],
        project === null ? null : <bdi>{project}</bdi>,
      ]} />
    </li>
  );
}

/** Spec 9.1 (3): the mitigations assigned to the reader, with their due dates, under the two definitions the sketch puts there. */
export function AssignedToYou({ base, items }: { base: HomeBase; items: readonly FollowUpItem[] }): ReactElement {
  return (
    <section className="home-section">
      <h2>{HOME_COPY.assignedHeading}</h2>
      <TermList terms={FOLLOW_UP_TERMS} />
      {items.length === 0
        ? <p className="home-empty">{HOME_COPY.assignedNone}</p>
        : <ul className="home-plates" role="list">{items.map((i) => <MitigationPlate key={i.mitigationId} base={base} item={i} showAssignee={false} />)}</ul>}
    </section>
  );
}
