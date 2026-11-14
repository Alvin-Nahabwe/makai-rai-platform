import type { ReactElement } from 'react';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { CloseByDecisionButton } from '@/components/findings/CloseByDecisionButton';
import { RaiseFindingForm } from '@/components/findings/RaiseFindingForm';
import { ListLink } from '@/components/ui/ListLink';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { LIST_PAGE_SIZE, pageOf } from '@/lib/ui/showMore';
import { STAGE_NAMES } from '@/lib/findings/labels';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import type { FindingListItem, FindingsPageData } from '@/lib/findings/pageData';
import { STAGES, type Stage } from '@/types/record';
import '@/components/ui/PageHeader.css';
import './Findings.css';

/**
 * S-14, the findings list of a project (SRS 7.4.2 S-14 row, UX-15, UX-07; owner default B40). No hooks: the page loads
 * `FindingsPageData` and this renders it, so a unit test renders the markup without the loader. Groups in UX-15's order:
 * the two "Ready to close" groups, the open findings of each stage under a heading that carries the count of what it
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

export function FindingsPageView({ data }: { data: FindingsPageData }): ReactElement {
  const d = data;
  const hasAny = d.decisionDone.length + d.decisionWithdrawn.length + d.stages.length + d.lookAgain.length + d.closed.length + d.withdrawn.length > 0;
  const allStages = `/orgs/${d.orgSlug}/projects/${d.projectId}/findings`;
  return (
    <div className="page-content finding-page">
      <ArchivedBanner archived={d.archived} />
      <div className="ui-page-header">
        <div>
          <ListLink href={`/orgs/${d.orgSlug}/projects/${d.projectId}`} className="finding-back">{L.backTo} <bdi>{d.projectName}</bdi></ListLink>
          <h1 className="ui-page-header__title">{FINDINGS_COPY.titles.findings}</h1>
        </div>
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
      {d.raise === null ? null : <RaiseFindingForm orgSlug={d.orgSlug} projectId={d.projectId} data={d.raise} />}
      {d.empty ? (
        <p className="finding-empty">{L.emptyProject}</p>
      ) : !hasAny ? (
        <p className="finding-empty">{L.emptyStage}</p>
      ) : null}
      <Group id="g-done" heading={L.decisionDone} d={d} items={d.decisionDone} />
      <Group id="g-withdrawn-decision" heading={L.decisionWithdrawn} d={d} items={d.decisionWithdrawn} />
      {d.stages.map((g) => (
        <section key={g.stage} aria-labelledby={`g-${g.stage}`} className="finding-group">
          <h2 id={`g-${g.stage}`}>{g.heading}</h2>
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
    </div>
  );
}
