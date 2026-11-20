import type { ReactElement } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { Breadcrumb } from '@/components/ui/Breadcrumb';
import { ListLink } from '@/components/ui/ListLink';
import { Definition, Term } from '@/components/ui/Definition';
import { StageMeaning, stageTerm } from '@/components/question/StageMeaning';
import { StageTally } from '@/components/question/StageTally';
import { SealStep } from '@/components/review/SealStep';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import type { StatusMarkKind } from '@/components/ui/types';
import { draftLine, WORKING_REPORT_PAGE } from '@/lib/documents/copy';
import { endItems } from '@/lib/question/stageEnd';
import { QUESTION_COPY } from '@/lib/question/copy';
import { STAGE_TITLE, type StageRow } from '@/lib/question/stageList';
import { nextStageThatApplies } from '@/lib/project/applicability';
import type { SealStepState } from '@/lib/review/sealStep';
import type { WorkingReportSummary } from '@/lib/documents/workingReport';
import type { Stage, UtcInstant } from '@/types/record';
import './StageEnd.css';

const E = QUESTION_COPY.end;

/** The next-stage link's words, with the stage's name marked as its term (the vocabulary defines it at first use). */
function nextLabel(words: string, name: string, stage: Stage): ReactElement {
  const at = words.indexOf(name);
  if (at < 0) throw new Error(`StageEnd: "${words}" does not hold "${name}"`);
  return <>{words.slice(0, at)}<Term of={stageTerm(stage)}>{name}</Term>{words.slice(at + name.length)}</>;
}

export type StageEndProps = {
  orgSlug: string; projectId: string; projectName: string; projectArchived?: boolean; stage: Stage; takenAt: UtcInstant;
  rows: readonly StageRow[]; marks: Readonly<Record<string, StatusMarkKind>>;
  summary: WorkingReportSummary;
  /** The stages that apply to this project (G7). The next stage offered is the first that applies after this one. */
  applies: ReadonlySet<Stage>;
  /** Whether the viewer may record: "Start <next stage>" for them, "View <next stage>" at the same address for everyone else. */
  canWrite: boolean;
  sealStep: SealStepState;
};

/**
 * The end of a stage (path to outputs, design G3; owner's choice B: at the end of a stage, the report leads). Saving the last
 * question of a stage lands here, and the stage page and the last question link back to it. It says where the project stands,
 * in this order: the draft line (so a screenshot never reads as sealed), the stage's tally in words, the first three of this
 * stage's open items under page 1's risk-area groups (with controls only when page 1 shows them), the primary action "Open the
 * working report", then the next stage and the seal step for the viewer's role. A role that cannot record sees "View" for the
 * next stage, so no control is offered that the role cannot use (anti-goal 4). It reads only; nothing here writes.
 */
export function StageEnd(p: StageEndProps): ReactElement {
  const base = `/orgs/${p.orgSlug}/projects/${p.projectId}`;
  const next = nextStageThatApplies(p.applies, p.stage);
  const { groups, more } = endItems(p.summary, p.stage);
  const nextName = next === null ? null : STAGE_TITLE[next];
  return (
    <div className="page-content stage-end">
      <ArchivedBanner archived={p.projectArchived ?? false} />
      <Breadcrumb items={[{ label: p.projectName, href: base }, { label: STAGE_TITLE[p.stage], href: `${base}/stages/${p.stage}` }, { label: E.title }]} />
      <h1>{E.heading}</h1>
      <p className="stage-end__draft" data-report-draft>{draftLine(p.takenAt)}</p>

      <section className="stage-end__stage" aria-labelledby="stage-end-stage">
        <h2 id="stage-end-stage"><Term of={stageTerm(p.stage)}>{STAGE_TITLE[p.stage]}</Term></h2>
        <StageMeaning stage={p.stage} />
        <StageTally rows={p.rows} marks={p.marks} />
      </section>

      <section className="stage-end__open" aria-labelledby="stage-end-open">
        <h2 id="stage-end-open">{E.openHeading}</h2>
        {groups.length === 0 ? <p>{E.nothingOpen}</p> : null}
        {groups.map((g) => (
          <div key={g.areaId ?? g.areaName} className="stage-end__group">
            <h3>{g.areaName}</h3>
            <ul className="stage-end__items" role="list">
              {g.items.map((i) => (
                <li key={i.findingId} className="stage-end__item" data-open-item>
                  {i.questionId === null
                    ? i.title
                    : <ListLink href={`${base}/stages/${i.stage}/questions/${i.questionId}`}>{i.title}</ListLink>}
                  {p.summary.controlsShown && i.controls.length > 0 ? (
                    <div className="stage-end__controls">
                      <p>{WORKING_REPORT_PAGE.controls}</p>
                      <ul role="list">{i.controls.map((c) => <li key={c.id} data-control>{`${c.name} (${c.id})`}</li>)}</ul>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {more > 0 ? <p className="stage-end__more">{E.more(more)}</p> : null}
      </section>

      <div className="stage-end__actions">
        <p className="stage-end__primary"><ButtonLink variant="primary" href={`${base}/report`}>{E.openReport}</ButtonLink></p>
        {next === null || nextName === null ? null : (
          <p className="stage-end__next">
            <ButtonLink variant="secondary" href={`${base}/stages/${next}`}>
              {nextLabel(p.canWrite ? E.start(nextName) : E.view(nextName), nextName, next)}
            </ButtonLink>
            {' '}<Definition of={stageTerm(next)} />
          </p>
        )}
        <SealStep orgSlug={p.orgSlug} projectId={p.projectId} stage={p.stage} state={p.sealStep} />
      </div>
    </div>
  );
}
