import type { ReactElement } from 'react';
import type { FindingView } from '@/types/api';
import type { HomeBase, TeamLead } from '@/lib/home/types';
import { HOME_COPY } from '@/lib/home/copy';
import { ListLink } from '@/components/ui/ListLink';
import { STAGE_NAME } from '@/components/project/StageColumn';
import { MitigationPlate } from '@/components/home/AssignedToYou';
import { MetaLine, findingLabel, projectNameIfMany } from '@/components/home/parts';

/** One finding as a plate: its name as the link to it, then its stage, and its project when there is more than one. */
export function FindingPlate({ base, finding }: { base: HomeBase; finding: FindingView }): ReactElement {
  const project = projectNameIfMany(base, finding.projectId);
  return (
    <li className="home-plate">
      <ListLink className="home-plate__title" href={`/orgs/${base.orgSlug}/projects/${finding.projectId}/findings/${finding.id}`}>
        <bdi>{findingLabel(finding)}</bdi>
      </ListLink>
      <MetaLine parts={[STAGE_NAME[finding.stage], project === null ? null : <bdi>{project}</bdi>]} />
    </li>
  );
}

/**
 * An Owner's or Admin's addition (spec 9.1), above the stages: the overdue mitigations, each with who it is assigned to in
 * ink and its due date (only the word "Overdue" red), and the findings with no mitigation yet. A list with nothing in it
 * is not shown: no heading stands over nothing (principle 2).
 */
export function TeamLeadAdditions({ base, lead }: { base: HomeBase; lead: TeamLead }): ReactElement | null {
  if (lead.overdue.length === 0 && lead.withoutMitigation.length === 0) return null;
  return (
    <>
      {lead.overdue.length > 0 ? (
        <section className="home-section">
          <h2>{HOME_COPY.leadOverdueHeading}</h2>
          <ul className="home-plates" role="list">{lead.overdue.map((i) => <MitigationPlate key={i.mitigationId} base={base} item={i} showAssignee />)}</ul>
        </section>
      ) : null}
      {lead.withoutMitigation.length > 0 ? (
        <section className="home-section">
          <h2>{HOME_COPY.leadNoMitigationHeading}</h2>
          <ul className="home-plates" role="list">{lead.withoutMitigation.map((f) => <FindingPlate key={f.id} base={base} finding={f} />)}</ul>
        </section>
      ) : null}
    </>
  );
}
