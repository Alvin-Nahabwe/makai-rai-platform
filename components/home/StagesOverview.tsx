import type { ReactElement } from 'react';
import type { Stage } from '@/types/record';
import type { NextStep, StageOpen } from '@/lib/home/types';
import type { StatusMarkKind } from '@/components/ui/types';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import { HOME_COPY } from '@/lib/home/copy';
import { PROJECT_COPY } from '@/lib/project/copy';
import { positionWords, tallyWords } from '@/lib/ui/copy';
import { questionHref } from '@/lib/question/draft';
import { TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3 } from '@/lib/vocabulary/terms';
import { ListLink } from '@/components/ui/ListLink';
import { MarkShape } from '@/components/ui/StatusMark';
import { Definition, Term } from '@/components/ui/Definition';
import { STAGE_NAME, plural } from '@/components/project/StageColumn';
import { OverdueWord } from '@/components/home/parts';

const C = PROJECT_COPY.stage;
const STAGE_TERM: Readonly<Record<Stage, DefinedEntry>> = { 'pre-processing': TERM_STAGE_1, 'in-processing': TERM_STAGE_2, 'post-processing': TERM_STAGE_3 };
/**
 * The kinds of a tally in the kit's order (spec 7.2's table), "no decision" last, as the sketch lists them. A record over
 * every kind, so a kind added to the kit fails to compile here rather than vanishing from the tally.
 */
const TALLY_RANK: Readonly<Record<StatusMarkKind, number>> = {
  done: 0, partly: 1, not_yet: 2, not_applicable: 3, does_not_apply: 4, scope_answered: 5, no_decision: 6,
};
const TALLY_ORDER = (Object.keys(TALLY_RANK) as StatusMarkKind[]).sort((a, b) => TALLY_RANK[a] - TALLY_RANK[b]);

type Heading = 'h2' | 'h3';
const below = (h: Heading): 'h3' | 'h4' => (h === 'h2' ? 'h3' : 'h4');

/**
 * The stage's line mark, as the sketch draws it beside each stage's name: a short navy line, with the action-orange stop
 * on the stage that holds the reader's next step. Drawing only (aria-hidden): the plate's "Next:" line says it in words.
 */
function LineMark({ here }: { here: boolean }): ReactElement {
  return (
    <svg className="home-stage__line" width="56" height="14" viewBox="0 0 56 14" aria-hidden="true" focusable="false">
      <path d="M2 7h52" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
      {here ? <circle className="home-stage__here" cx="28" cy="7" r="6" /> : null}
    </svg>
  );
}

/** The tally as the sketch lists it: one item per kind that occurs, the kit's mark beside its count in words. */
function Tally({ stage }: { stage: StageOpen }): ReactElement {
  const t = stage.tally;
  const kinds = TALLY_ORDER.filter((k) => (t[k] ?? 0) > 0);
  if (kinds.length === 0) return <p className="home-tally__none">{tallyWords(t)}</p>;
  return (
    <ul className="home-tally" role="list" aria-label={STAGE_NAME[stage.stage]}>
      {kinds.map((k) => (
        <li key={k} className="home-tally__item" data-tally-kind={k}>
          <MarkShape kind={k} size={16} />
          <span>{tallyWords(k === 'done' ? { done: t.done, doneNoEvidence: t.doneNoEvidence } : { [k]: t[k] })}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The plate's last line for a person who records: where to go next in this stage. The stage that holds the next step
 * names it by its place ("Question 5 of 22, your next step"); any other stage with a question open points at the first
 * of them, counted as the tally above counts them. Nothing open: no line.
 */
function NextLine({ orgSlug, projectId, stage, next }: { orgSlug: string; projectId: string; stage: StageOpen; next: NextStep | null }): ReactElement | null {
  const here = next !== null && next.projectId === projectId && next.stage === stage.stage;
  if (here) return <NextLink orgSlug={orgSlug} projectId={projectId} stage={stage.stage} questionId={next.questionId} words={HOME_COPY.nextHere(positionWords(next.position.n, next.position.of))} />;
  if (stage.nextOpen === null) return null;
  // The open question is one of the tally's "no decision" marks (the loader reads both from the same rows), so a stage
  // with an open question and no such mark is a mismatch to show, not a "first of 0" to print.
  const open = stage.tally.no_decision ?? 0;
  if (open < 1) throw new Error(`Home: ${stage.stage} has an open question but its tally counts no question with no decision`);
  return <NextLink orgSlug={orgSlug} projectId={projectId} stage={stage.stage} questionId={stage.nextOpen.questionId} words={HOME_COPY.nextFirstOf(open)} />;
}

function NextLink({ orgSlug, projectId, stage, questionId, words }: { orgSlug: string; projectId: string; stage: Stage; questionId: string; words: string }): ReactElement {
  const target = { id: questionId, words };
  return (
    <p className="home-stage__next">
      <b>{HOME_COPY.next}</b>{' '}
      <ListLink href={questionHref({ orgSlug, projectId, stage }, target.id)}>{target.words}</ListLink>
    </p>
  );
}

/**
 * One stage as a plate (sketch home.png; spec 9.1 (5), principle 2): the line mark, the stage's name (a link to its
 * questions) with its question count, its definition (D1), then what is still open (open findings as a link to them, and
 * the overdue mitigations, "Overdue" red), then the tally in words with a mark per kind, then the "Next:" line for a person
 * who records. No count of zero is shown: a stage with nothing open has no open line.
 */
function StagePlate({ orgSlug, projectId, stage, next, recording, heading }: {
  orgSlug: string; projectId: string; stage: StageOpen; next: NextStep | null; recording: boolean; heading: 'h3' | 'h4';
}): ReactElement {
  const Heading = heading;
  const here = recording && next !== null && next.projectId === projectId && next.stage === stage.stage;
  const project = `/orgs/${orgSlug}/projects/${projectId}`;
  const open = stage.openFindings > 0 || stage.overdueMitigations > 0;
  return (
    <section className="home-stage" data-stage={stage.stage}>
      <div className="home-stage__head">
        <LineMark here={here} />
        <Heading className="home-stage__name">
          <ListLink href={`${project}/stages/${stage.stage}`}><Term of={STAGE_TERM[stage.stage]}>{STAGE_NAME[stage.stage]}</Term></ListLink>
        </Heading>
        <span className="home-stage__count">{plural(stage.stops.length, C.question, C.questions)}</span>
      </div>
      <Definition of={STAGE_TERM[stage.stage]} as="p" />
      {open ? (
        <p className="home-stage__open">
          {stage.openFindings > 0
            ? <ListLink href={`${project}/findings?stage=${stage.stage}`}>{plural(stage.openFindings, C.openFinding, C.openFindings)}</ListLink>
            : null}
          {stage.overdueMitigations > 0
            ? <ListLink href={`${project}#${stage.stage}`}><OverdueWord />{HOME_COPY.overdueCount(stage.overdueMitigations)}</ListLink>
            : null}
        </p>
      ) : null}
      <Tally stage={stage} />
      {recording ? <NextLine orgSlug={orgSlug} projectId={projectId} stage={stage} next={next} /> : null}
    </section>
  );
}

/**
 * A project's three stages (spec 9.1 (5)): its name as a heading linked to the project page, the lead line, then the three
 * plates in stage order. `recording` is false for a Viewer: no "Next:" line and no "you are here" stop.
 */
export function StagesOverview({ orgSlug, projectId, projectName, stages, next, recording, heading }: {
  orgSlug: string; projectId: string; projectName: string; stages: readonly StageOpen[]; next: NextStep | null; recording: boolean; heading: Heading;
}): ReactElement {
  const Heading = heading;
  return (
    <section className="home-section home-project">
      <Heading className="home-project__name">
        <ListLink href={`/orgs/${orgSlug}/projects/${projectId}`}><bdi>{projectName}</bdi></ListLink>
      </Heading>
      {/* "You can work on the stages in any order" speaks to a person who records; a Viewer reads, so it is left out. */}
      {recording ? <p className="home-note">{HOME_COPY.stagesLead}</p> : null}
      <div className="home-stages">
        {stages.map((s) => (
          <StagePlate key={s.stage} orgSlug={orgSlug} projectId={projectId} stage={s} next={next} recording={recording} heading={below(heading)} />
        ))}
      </div>
    </section>
  );
}
