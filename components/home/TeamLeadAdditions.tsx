import type { ReactElement } from 'react';
import type { FindingView, FollowUpItem } from '@/types/api';
import type { HomeBase, TeamLead } from '@/lib/home/types';
import { HOME_COPY } from '@/lib/home/copy';
import { PROJECT_COPY } from '@/lib/project/copy';
import { formatDay } from '@/lib/format/dates';
import { findingsHref } from '@/lib/shell/nav';
import { ListLink } from '@/components/ui/ListLink';
import type { FirstUses } from '@/components/home/firstUse';
import { LEAD_CAP } from '@/components/home/limits';
import { MetaLine, OverdueDue, SLOT, StageName, TermHeading, findingLabel, personName, projectNameIfMany, withSlot } from '@/components/home/parts';

const F = PROJECT_COPY.followUp;

/** One finding as a plate (a Reviewer's "Findings you raised"): its name as the link, then its stage and project. */
export function FindingPlate({ base, finding }: { base: HomeBase; finding: FindingView }): ReactElement {
  const project = projectNameIfMany(base, finding.projectId);
  return (
    <li className="home-plate">
      <ListLink className="home-plate__title" href={`/orgs/${base.orgSlug}/projects/${finding.projectId}/findings/${finding.id}`}>
        <bdi>{findingLabel(finding)}</bdi>
      </ListLink>
      <MetaLine parts={[<StageName key="stage" stage={finding.stage} />, project === null ? null : <bdi>{project}</bdi>]} />
    </li>
  );
}

/**
 * One overdue mitigation as a compact row (design review #7): its words as the link to its finding on one line, then
 * "Assigned to <name>" in ink (or "Assigned to you" for the reader's own) and "Overdue: was due <date>" with the word and
 * the date red (spec 7.1, 9.1), and its project when there are several.
 */
function OverdueRow({ base, item }: { base: HomeBase; item: FollowUpItem }): ReactElement {
  const project = projectNameIfMany(base, item.projectId);
  const who = item.owner.userId === base.userId ? HOME_COPY.assignedToReader : withSlot(HOME_COPY.assignedToName(SLOT), personName(item.owner));
  const words = item.what ?? F.erased;
  return (
    <li className="home-row">
      <ListLink className="home-row__title" href={`/orgs/${base.orgSlug}/projects/${item.projectId}/findings/${item.findingId}`}>
        <bdi title={words}>{words}</bdi>
      </ListLink>
      <MetaLine parts={[<span key="who">{who}</span>, <OverdueDue key="due" day={formatDay(item.dueDate)} />, project === null ? null : <bdi>{project}</bdi>]} />
    </li>
  );
}

/** One finding with no mitigation as a compact row: its name as the link on one line, then its stage and project. */
function FindingRow({ base, finding }: { base: HomeBase; finding: FindingView }): ReactElement {
  const project = projectNameIfMany(base, finding.projectId);
  const words = findingLabel(finding);
  return (
    <li className="home-row">
      <ListLink className="home-row__title" href={`/orgs/${base.orgSlug}/projects/${finding.projectId}/findings/${finding.id}`}>
        <bdi title={words}>{words}</bdi>
      </ListLink>
      <MetaLine parts={[<StageName key="stage" stage={finding.stage} />, project === null ? null : <bdi>{project}</bdi>]} />
    </li>
  );
}

/**
 * The link under a list cut at LEAD_CAP rows (nothing when the list is not cut). With one active project it names the
 * whole list's count and opens the project's Findings page, which groups both kinds; with several it says what the rail's
 * Findings entry does, choose a project (code review M2: a count across projects would promise a list that page lacks).
 */
function WholeList({ base, total, words }: { base: HomeBase; total: number; words: (n: number) => string }): ReactElement | null {
  if (total <= LEAD_CAP) return null;
  const one = base.projects.length === 1;
  const href = one ? `/orgs/${base.orgSlug}/projects/${base.projects[0].id}/findings` : findingsHref(base.orgSlug, null);
  return <p className="home-more-link"><ListLink href={href}>{one ? words(total) : PROJECT_COPY.chooseForFindings}</ListLink></p>;
}

/**
 * An Owner's or Admin's addition (spec 9.1), above the stages: the overdue mitigations, each with who it is assigned to in
 * ink and its due date (the word "Overdue" and the date red), and the findings with no mitigation yet. Each list is
 * compact rows, its first LEAD_CAP, then one link to the whole list (lane lead, fix rounds 1 and 2). A list with nothing
 * in it is not shown: no heading stands over nothing (principle 2).
 */
export function TeamLeadAdditions({ base, lead, uses }: { base: HomeBase; lead: TeamLead; uses: FirstUses }): ReactElement | null {
  if (lead.overdue.length === 0 && lead.withoutMitigation.length === 0) return null;
  return (
    <>
      {lead.overdue.length > 0 ? (
        <section className="home-section">
          <TermHeading uses={uses} where="terms:lead-overdue" text={HOME_COPY.leadOverdueHeading} />
          <ul className="home-rows" role="list">
            {lead.overdue.slice(0, LEAD_CAP).map((i) => <OverdueRow key={i.mitigationId} base={base} item={i} />)}
          </ul>
          <WholeList base={base} total={lead.overdue.length} words={HOME_COPY.leadOverdueAll} />
        </section>
      ) : null}
      {lead.withoutMitigation.length > 0 ? (
        <section className="home-section">
          <TermHeading uses={uses} where="terms:lead-none" text={HOME_COPY.leadNoMitigationHeading} />
          <ul className="home-rows" role="list">
            {lead.withoutMitigation.slice(0, LEAD_CAP).map((f) => <FindingRow key={f.id} base={base} finding={f} />)}
          </ul>
          <WholeList base={base} total={lead.withoutMitigation.length} words={HOME_COPY.leadNoMitigationAll} />
        </section>
      ) : null}
    </>
  );
}
