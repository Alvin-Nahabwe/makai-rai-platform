import type { ReactElement, ReactNode } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { Breadcrumb } from '@/components/ui/Breadcrumb';
import { ListLink } from '@/components/ui/ListLink';
import { Definition, Term } from '@/components/ui/Definition';
import { TermTip } from '@/components/ui/TermTip';
import { StageMeaning, stageTerm } from '@/components/question/StageMeaning';
import { StageTally } from '@/components/question/StageTally';
import { SealStep } from '@/components/review/SealStep';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import type { StatusMarkKind } from '@/components/ui/types';
import { draftLine, NO_RISK_AREA_GROUP, WORKING_REPORT_PAGE } from '@/lib/documents/copy';
import { endItems } from '@/lib/question/stageEnd';
import { STAGE_END_COPY } from '@/lib/question/end/copy';
import { STAGE_TITLE, type StageRow } from '@/lib/question/stageList';
import { nextStageThatApplies } from '@/lib/project/applicability';
import type { SealStepState } from '@/lib/review/sealStep';
import type { WorkingReportSummary } from '@/lib/documents/workingReport';
import { TERM_CONTROL, TERM_RISK_AREA, TERM_WORKING_REPORT } from '@/lib/vocabulary/terms';
import type { DefinedEntry, VocabularyEntry } from '@/lib/vocabulary/types';
import type { Stage, UtcInstant } from '@/types/record';
import './StageEnd.css';

const E = STAGE_END_COPY;

/**
 * `words` with the first occurrence of `name` marked as `term` (the vocabulary defines it at first use), or null when the words do
 * not hold the name (a copy change that dropped it): the caller then leaves the control out and nothing throws during the render.
 */
function marked(words: string, name: string, term: VocabularyEntry): ReactElement | null {
  const at = words.indexOf(name);
  if (at < 0) return null;
  return <>{words.slice(0, at)}<Term of={term}>{name}</Term>{words.slice(at + name.length)}</>;
}

/** The (i) beside a term the screen defines at its first use. */
const tip = (term: DefinedEntry): ReactElement => <TermTip of={term} label={E.whatMeans(term.term)} />;

export type StageEndProps = {
  orgSlug: string; projectId: string; projectName: string; projectArchived?: boolean; stage: Stage; takenAt: UtcInstant;
  rows: readonly StageRow[]; marks: Readonly<Record<string, StatusMarkKind>>;
  summary: WorkingReportSummary;
  /** The stages that apply to this project (G7). The next stage offered is the first that applies after this one. */
  applies: ReadonlySet<Stage>;
  /** Whether the viewer may record: "Start <next stage>" for them, "View <next stage>" at the same address for everyone else. */
  canWrite: boolean;
  /** Whether the running content holds the question in the stage; an item on one it does not hold is text, as its page would be not-found. */
  hasQuestion: (stage: Stage, questionId: string) => boolean;
  sealStep: SealStepState;
  /** The "saved" line a clean Save leaves when it led here (answer cost, design 2 item 3): above the heading, and it takes focus. */
  arrival?: ReactNode;
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
  const stageAt = `${base}/stages/${p.stage}`;
  const next = nextStageThatApplies(p.applies, p.stage);
  const { groups, more } = endItems(p.summary, p.stage);
  const nextLink = next === null ? null : marked(p.canWrite ? E.start(STAGE_TITLE[next]) : E.view(STAGE_TITLE[next]), STAGE_TITLE[next], stageTerm(next));
  // First uses on this screen, in reading order, each defined beside it: a risk area at the heading of the items that have none,
  // a control at the first "Suggested controls", the working report at the "more" line when there is one and else at the action.
  const firstControls = p.summary.controlsShown ? groups.flatMap((g) => g.items).find((i) => i.controls.length > 0)?.findingId ?? null : null;
  const reportInMore = more > 0;
  const reportLabel = reportInMore ? null : marked(E.openReport, 'working report', TERM_WORKING_REPORT);
  return (
    <div className="page-content stage-end">
      <ArchivedBanner archived={p.projectArchived ?? false} />
      <Breadcrumb items={[{ label: p.projectName, href: base }, { label: STAGE_TITLE[p.stage], href: stageAt }, { label: E.title }]} />
      {p.arrival ?? null}
      <h1>{E.heading}</h1>
      <p className="stage-end__draft" data-report-draft>{draftLine(p.takenAt)}</p>
      {/* This stage's recorded answers the draft leaves out (fix wave item 10), as page 1 says the project's. */}
      {p.summary.omittedByStage[p.stage] > 0 ? <p>{WORKING_REPORT_PAGE.omitted(p.summary.omittedByStage[p.stage])}</p> : null}

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
            <h3>
              {g.areaName === NO_RISK_AREA_GROUP ? <><Term of={TERM_RISK_AREA}>{g.areaName}</Term>{tip(TERM_RISK_AREA)}</> : g.areaName}
            </h3>
            <ul className="stage-end__items" role="list">
              {g.items.map((i) => (
                <li key={i.findingId} className="stage-end__item" data-open-item>
                  {i.questionId === null || !p.hasQuestion(i.stage, i.questionId)
                    ? i.title
                    : <ListLink href={`${base}/stages/${i.stage}/questions/${i.questionId}`}>{i.title}</ListLink>}
                  {p.summary.controlsShown && i.controls.length > 0 ? (
                    <div className="stage-end__controls">
                      {i.findingId === firstControls
                        ? <p><Term of={TERM_CONTROL}>{WORKING_REPORT_PAGE.controls}</Term>{tip(TERM_CONTROL)}</p>
                        : <p>{WORKING_REPORT_PAGE.controls}</p>}
                      <ul role="list">{i.controls.map((c) => <li key={c.id} data-control>{`${c.name} (${c.id})`}</li>)}</ul>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {reportInMore ? <p className="stage-end__more"><Term of={TERM_WORKING_REPORT}>{E.more(more)}</Term>{tip(TERM_WORKING_REPORT)}</p> : null}
      </section>

      <div className="stage-end__actions">
        <p className="stage-end__primary">
          <ButtonLink variant="primary" href={`${base}/report`}>{reportLabel ?? E.openReport}</ButtonLink>
          {reportLabel === null ? null : <>{' '}{tip(TERM_WORKING_REPORT)}</>}
        </p>
        {next === null || nextLink === null ? null : (
          <p className="stage-end__next">
            <ButtonLink variant="secondary" href={`${base}/stages/${next}`}>{nextLink}</ButtonLink>
            {' '}<Definition of={stageTerm(next)} />
          </p>
        )}
        <SealStep orgSlug={p.orgSlug} projectId={p.projectId} stage={p.stage} state={p.sealStep} />
      </div>
    </div>
  );
}
