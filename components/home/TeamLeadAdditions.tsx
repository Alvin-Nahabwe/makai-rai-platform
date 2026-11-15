import type { ReactElement } from 'react';
import type { FindingView } from '@/types/api';
import type { HomeBase, TeamLead } from '@/lib/home/types';
import { HOME_COPY } from '@/lib/home/copy';
import { findingsHref } from '@/lib/shell/nav';
import { ListLink } from '@/components/ui/ListLink';
import { MitigationPlate } from '@/components/home/AssignedToYou';
import { LEAD_CAP, type FirstUses } from '@/components/home/firstUse';
import { Defs, MetaLine, StageName, TermHeading, findingLabel, projectNameIfMany } from '@/components/home/parts';

/** One finding as a plate: its name as the link to it, then its stage, and its project when there is more than one. */
export function FindingPlate({ base, finding, uses, where }: { base: HomeBase; finding: FindingView; uses: FirstUses; where: string }): ReactElement {
  const project = projectNameIfMany(base, finding.projectId);
  return (
    <li className="home-plate">
      <ListLink className="home-plate__title" href={`/orgs/${base.orgSlug}/projects/${finding.projectId}/findings/${finding.id}`}>
        <bdi>{findingLabel(finding)}</bdi>
      </ListLink>
      <MetaLine parts={[<StageName key="stage" stage={finding.stage} />, project === null ? null : <bdi>{project}</bdi>]} />
      <Defs uses={uses} where={where} />
    </li>
  );
}

/**
 * Where the whole of a lead list is: the project's Findings page (its findings with no mitigation, and with overdue
 * mitigations, are grouped there), or with several projects the rail's Findings entry, which asks which project.
 */
function wholeListHref(base: HomeBase): string {
  return base.projects.length === 1 ? `/orgs/${base.orgSlug}/projects/${base.projects[0].id}/findings` : findingsHref(base.orgSlug, null);
}

/** The link under a list cut at LEAD_CAP plates, with the whole list's count; nothing when the list is not cut. */
function WholeList({ base, total, words }: { base: HomeBase; total: number; words: (n: number) => string }): ReactElement | null {
  if (total <= LEAD_CAP) return null;
  return <p className="home-more-link"><ListLink href={wholeListHref(base)}>{words(total)}</ListLink></p>;
}

/**
 * An Owner's or Admin's addition (spec 9.1), above the stages: the overdue mitigations, each with who it is assigned to in
 * ink and its due date (only the word "Overdue" red), and the findings with no mitigation yet. Each list shows its first
 * LEAD_CAP plates, then one link to the whole list with its count (lane lead, fix round 1). A list with nothing in it is
 * not shown: no heading stands over nothing (principle 2).
 */
export function TeamLeadAdditions({ base, lead, uses }: { base: HomeBase; lead: TeamLead; uses: FirstUses }): ReactElement | null {
  if (lead.overdue.length === 0 && lead.withoutMitigation.length === 0) return null;
  return (
    <>
      {lead.overdue.length > 0 ? (
        <section className="home-section">
          <TermHeading uses={uses} where="terms:lead-overdue" text={HOME_COPY.leadOverdueHeading} />
          <ul className="home-plates" role="list">
            {lead.overdue.slice(0, LEAD_CAP).map((i) => (
              <MitigationPlate key={i.mitigationId} base={base} item={i} showAssignee uses={uses} where={`lead-overdue:${i.mitigationId}`} />
            ))}
          </ul>
          <WholeList base={base} total={lead.overdue.length} words={HOME_COPY.leadOverdueAll} />
        </section>
      ) : null}
      {lead.withoutMitigation.length > 0 ? (
        <section className="home-section">
          <TermHeading uses={uses} where="terms:lead-none" text={HOME_COPY.leadNoMitigationHeading} />
          <ul className="home-plates" role="list">
            {lead.withoutMitigation.slice(0, LEAD_CAP).map((f) => (
              <FindingPlate key={f.id} base={base} finding={f} uses={uses} where={`lead-finding:${f.id}`} />
            ))}
          </ul>
          <WholeList base={base} total={lead.withoutMitigation.length} words={HOME_COPY.leadNoMitigationAll} />
        </section>
      ) : null}
    </>
  );
}
