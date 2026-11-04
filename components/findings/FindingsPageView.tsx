import type { ReactElement } from 'react';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { CloseByDecisionButton } from '@/components/findings/CloseByDecisionButton';
import { RaiseFindingForm } from '@/components/findings/RaiseFindingForm';
import { ListLink } from '@/components/ui/ListLink';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { LIST_PAGE_SIZE, pageOf } from '@/lib/ui/showMore';
import { STAGE_NAMES } from '@/lib/findings/labels';
import type { FindingListItem, FindingsPageData } from '@/lib/findings/pageData';
import { STAGES, type Stage } from '@/types/record';

/**
 * S-14, the findings list of a project (SRS 7.4.2 S-14 row, UX-15, UX-07; owner default B40). No hooks: the page loads
 * `FindingsPageData` and this renders it, so a unit test renders the markup without the loader. Groups in UX-15's order:
 * "Decision now done: close it", "Decision withdrawn: close it", the open findings of each stage under a heading that
 * carries the count of what it lists, "Accepted risks to look at again", "Closed", "Withdrawn". An empty group is not shown.
 * No element holds a number summed across stages. Each list shows 50 items and "Show more" (UX-40); a stage heading still
 * counts its whole group.
 */

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
    <li>
      <ListLink href={`/orgs/${d.orgSlug}/projects/${d.projectId}/findings/${f.id}`}><bdi>{f.title}</bdi></ListLink>
      <p>
        {f.sourceLabel}{' . '}<span className="status-label">{f.stateLabel}</span>
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
      <ul>{page.items.map((f) => <FindingItem key={f.id} d={d} f={f} />)}</ul>
      {page.hasMore ? <ShowMoreLink href={listUrl(d, { shown: String(page.nextShown) })} label="Show more" /> : null}
    </>
  );
}

function Group({ id, heading, d, items }: { id: string; heading: string; d: FindingsPageData; items: readonly FindingListItem[] }): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{heading}</h2>
      <FindingList d={d} items={items} />
    </section>
  );
}

export function FindingsPageView({ data }: { data: FindingsPageData }): ReactElement {
  const d = data;
  const hasAny = d.decisionDone.length + d.decisionWithdrawn.length + d.stages.length + d.lookAgain.length + d.closed.length + d.withdrawn.length > 0;
  const allStages = `/orgs/${d.orgSlug}/projects/${d.projectId}/findings`;
  return (
    <div className="page-content">
      <ArchivedBanner archived={d.archived} />
      <div className="page-header">
        <div>
          <ListLink href={`/orgs/${d.orgSlug}/projects/${d.projectId}`} className="back-link">Back to <bdi>{d.projectName}</bdi></ListLink>
          <h1>Findings</h1>
        </div>
      </div>
      <nav aria-label="Filter the list">
        <ul>
          <li><ListLink href={allStages} aria-current={d.stageFilter === null ? 'page' : undefined}>All stages</ListLink></li>
          {STAGES.map((s: Stage) => (
            <li key={s}>
              <ListLink href={`${allStages}?stage=${s}`} aria-current={d.stageFilter === s ? 'page' : undefined}>{STAGE_NAMES[s]}</ListLink>
            </li>
          ))}
        </ul>
      </nav>
      {d.raise === null ? null : <RaiseFindingForm orgSlug={d.orgSlug} projectId={d.projectId} data={d.raise} />}
      {d.empty ? (
        <p>No findings in this project. A finding opens when a decision is saved as Partly or Not yet, or when someone raises one.</p>
      ) : !hasAny ? (
        <p>No findings in this stage.</p>
      ) : null}
      <Group id="g-done" heading="Decision now done: close it" d={d} items={d.decisionDone} />
      <Group id="g-withdrawn-decision" heading="Decision withdrawn: close it" d={d} items={d.decisionWithdrawn} />
      {d.stages.map((g) => (
        <section key={g.stage} aria-labelledby={`g-${g.stage}`}>
          <h2 id={`g-${g.stage}`}>{g.heading}</h2>
          {([['Open, no mitigation yet', g.noMitigation], ['Open, with overdue mitigations', g.overdue], ['Open', g.other]] as const).map(([name, items]) =>
            items.length === 0 ? null : (
              <section key={name} aria-label={`${g.name}: ${name}`}>
                <h3>{name}</h3>
                <FindingList d={d} items={items} />
              </section>
            ))}
        </section>
      ))}
      <Group id="g-look-again" heading="Accepted risks to look at again" d={d} items={d.lookAgain} />
      <Group id="g-closed" heading="Closed" d={d} items={d.closed} />
      <Group id="g-withdrawn" heading="Withdrawn" d={d} items={d.withdrawn} />
    </div>
  );
}
