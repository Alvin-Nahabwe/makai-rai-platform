import type { ReactElement } from 'react';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { CloseByDecisionButton } from '@/components/findings/CloseByDecisionButton';
import { RaiseFindingForm } from '@/components/findings/RaiseFindingForm';
import { ListLink } from '@/components/ui/ListLink';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { LIST_PAGE_SIZE, pageOf } from '@/lib/ui/showMore';
import { STAGE_NAMES } from '@/lib/findings/labels';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { Definition, Term } from '@/components/ui/Definition';
import { TermList, termListId, type TermListItem } from '@/components/review/TermList';
import { STAGE_TERMS, STATUS_TERMS } from '@/lib/review/copy';
import { TERM_ACCEPTED_RISK, TERM_FINDING, TERM_MITIGATION } from '@/lib/vocabulary/terms';
import type { FindingListItem, FindingsPageData } from '@/lib/findings/pageData';
import { STAGES, type DecisionStatus, type Stage } from '@/types/record';
import '@/components/ui/pageHeaderStyles';
import './Findings.css';

/**
 * S-14, the findings list of a project (SRS 7.4.2 S-14 row, UX-15, UX-07; owner default B40). No hooks: the page loads
 * `FindingsPageData` and this renders it, so a unit test renders the markup without the loader. Groups in UX-15's order:
 * the three "Ready to close" groups (R3), the open findings of each stage under a heading that carries the count of what it
 * lists, "Accepted risks to check again", "Closed", "Withdrawn". An empty group is not shown. No element holds a number
 * summed across stages. Each list shows 50 items and "Show more" (UX-40); a stage heading still counts its whole group.
 * The words are `FINDINGS_COPY.list`'s (lib/findings/copy.ts).
 */

const L = FINDINGS_COPY.list;

const listUrl = (d: FindingsPageData, extra: Record<string, string>): string => {
  const q = new URLSearchParams();
  if (d.stageFilter !== null) q.set('stage', d.stageFilter);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  const text = q.toString();
  return `/orgs/${d.orgSlug}/projects/${d.projectId}/findings${text === '' ? '' : `?${text}`}`;
};

function FindingItem({ d, f }: { d: FindingsPageData; f: FindingListItem }): ReactElement {
  const closeReason = f.state === 'open' && f.decisionVersionId !== null ? f.closeReason : null;
  return (
    <li className="finding-row">
      <ListLink href={`/orgs/${d.orgSlug}/projects/${d.projectId}/findings/${f.id}`} className="finding-row__title"><bdi>{f.title}</bdi></ListLink>
      <p className="finding-row__meta">
        {f.sourceLabel}{FINDINGS_COPY.separator}<bdi className="status-label">{f.stateLabel}</bdi>
      </p>
      {d.canClose && closeReason !== null && f.decisionVersionId !== null ? (
        <CloseByDecisionButton
          orgSlug={d.orgSlug} projectId={d.projectId} findingId={f.id} decisionVersionId={f.decisionVersionId}
          reason={closeReason} findingTitle={f.title}
        />
      ) : null}
    </li>
  );
}

/** One list of at most one page of items, with its "Show more" (UX-40). */
function FindingList({ d, items }: { d: FindingsPageData; items: readonly FindingListItem[] }): ReactElement {
  const page = pageOf(items, d.shown, LIST_PAGE_SIZE);
  return (
    <>
      <ul className="finding-list">{page.items.map((f) => <FindingItem key={f.id} d={d} f={f} />)}</ul>
      {page.hasMore ? <ShowMoreLink href={listUrl(d, { shown: String(page.nextShown) })} label={L.showMore} /> : null}
    </>
  );
}

function Group({ id, heading, d, items }: { id: string; heading: string; d: FindingsPageData; items: readonly FindingListItem[] }): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={id} className="finding-group">
      <h2 id={id}>{heading}</h2>
      <FindingList d={d} items={items} />
    </section>
  );
}

/** The prefix of the ids of the definitions under the heading. */
const TERMS_ID = 'findings-term';

/**
 * The terms defined under the heading (spec 6; the findings sketch): "finding", which the heading holds; "mitigation",
 * which the stage groups' headings use ("Open, no mitigation yet"); the decision statuses the rows name ("From a
 * decision: Partly") or, for a project with no finding, the empty line names; and "accepted risk" when a row or a group
 * says it. Each is listed only when the page shows it.
 */
function listTerms(d: FindingsPageData): TermListItem[] {
  const rows = [
    ...d.decisionDone, ...d.decisionWithdrawn, ...d.gateNo, ...d.stages.flatMap((g) => [...g.noMitigation, ...g.overdue, ...g.other]),
    ...d.lookAgain, ...d.closed, ...d.withdrawn,
  ];
  const used = new Set<string>(rows.map((r) => r.sourceStatus).filter((x): x is DecisionStatus => x !== null && x !== 'withdrawn'));
  // "No findings yet. The platform raises a finding when a decision is saved as Partly or Not yet."
  if (d.empty) { used.add('partly'); used.add('not_yet'); }
  const statuses = (Object.keys(STATUS_TERMS) as DecisionStatus[]).filter((s) => used.has(s)).map((s) => ({ of: STATUS_TERMS[s], marked: true }));
  const accepted = d.lookAgain.length > 0 || rows.some((r) => r.state === 'closed_accepted_risk');
  return [
    { of: TERM_FINDING, marked: false }, { of: TERM_MITIGATION, marked: true }, ...statuses,
    ...(accepted ? [{ of: TERM_ACCEPTED_RISK, marked: true }] : []),
  ];
}

export function FindingsPageView({ data }: { data: FindingsPageData }): ReactElement {
  const d = data;
  const hasAny = d.decisionDone.length + d.decisionWithdrawn.length + d.gateNo.length + d.stages.length + d.lookAgain.length + d.closed.length + d.withdrawn.length > 0;
  const allStages = `/orgs/${d.orgSlug}/projects/${d.projectId}/findings`;
  return (
    <div className="page-content finding-page">
      <ArchivedBanner archived={d.archived} />
      <div className="ui-page-header">
        <div>
          <ListLink href={`/orgs/${d.orgSlug}/projects/${d.projectId}`} className="finding-back">{L.backTo} <bdi>{d.projectName}</bdi></ListLink>
          <h1 className="ui-page-header__title" aria-describedby={termListId(TERMS_ID, TERM_FINDING)}><Term of={TERM_FINDING}>{FINDINGS_COPY.titles.findings}</Term></h1>
        </div>
        <TermList idPrefix={TERMS_ID} items={listTerms(d)} />
      </div>
      <nav aria-label={L.filter} className="finding-filter">
        <ul>
          <li><ListLink href={allStages} aria-current={d.stageFilter === null ? 'page' : undefined}>{L.allStages}</ListLink></li>
          {STAGES.map((s: Stage) => (
            <li key={s}>
              <ListLink href={`${allStages}?stage=${s}`} aria-current={d.stageFilter === s ? 'page' : undefined}>{STAGE_NAMES[s]}</ListLink>
            </li>
          ))}
        </ul>
      </nav>
      {d.empty ? (
        <p className="finding-empty">{L.emptyProject}</p>
      ) : !hasAny ? (
        <p className="finding-empty">{L.emptyStage}</p>
      ) : null}
      <Group id="g-done" heading={L.decisionDone} d={d} items={d.decisionDone} />
      <Group id="g-withdrawn-decision" heading={L.decisionWithdrawn} d={d} items={d.decisionWithdrawn} />
      <Group id="g-gate-no" heading={L.gateNo} d={d} items={d.gateNo} />
      {d.stages.map((g) => (
        <section key={g.stage} aria-labelledby={`g-${g.stage}`} className="finding-group">
          {/* The group's heading holds the page's first use of the stage's name: its meaning follows it (D1). */}
          <h2 id={`g-${g.stage}`}><Term of={STAGE_TERMS[g.stage]}>{g.name}</Term>{FINDINGS_COPY.labels.stageCountRest(g.count)}</h2>
          <Definition of={STAGE_TERMS[g.stage]} as="p" />
          {([[L.noMitigation, g.noMitigation], [L.overdue, g.overdue], [L.open, g.other]] as const).map(([name, items]) =>
            items.length === 0 ? null : (
              <section key={name} aria-label={L.groupLabel(g.name, name)} className="finding-subgroup">
                <h3>{name}</h3>
                <FindingList d={d} items={items} />
              </section>
            ))}
        </section>
      ))}
      <Group id="g-look-again" heading={L.lookAgain} d={d} items={d.lookAgain} />
      <Group id="g-closed" heading={L.closed} d={d} items={d.closed} />
      <Group id="g-withdrawn" heading={L.withdrawn} d={d} items={d.withdrawn} />
      {/* R5 (S10): the lists first, then the raise form (it keeps id="raise", where S-12's link lands). */}
      {d.raise === null ? null : <RaiseFindingForm orgSlug={d.orgSlug} projectId={d.projectId} data={d.raise} />}
    </div>
  );
}
