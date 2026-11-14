import './StageView.css';
import type { ReactElement, ReactNode } from 'react';
import type { StageCounts } from '@/types/api';
import type { Stage } from '@/types/record';
import { ListLink } from '@/components/ui/ListLink';
import { MarkShape } from '@/components/ui/StatusMark';
import type { StatusMarkKind } from '@/components/ui/types';
import { tallyWords, UI_COPY } from '@/lib/ui/copy';
import type { Tally } from '@/lib/ui/marks';
import { PROJECT_COPY } from '@/lib/project/copy';

/** The stage names and the line under each (SRS W-1), read from the project screens' copy module. */
export const STAGE_NAME: Readonly<Record<Stage, string>> = PROJECT_COPY.stageNames;
const STAGE_LINE: Readonly<Record<Stage, string>> = PROJECT_COPY.stageLines;

const C = PROJECT_COPY.stage;

/** "1 question", "2 questions". */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The kinds of "Recorded so far", in the kit's order (spec 7.2's table). No decision is not one: it is still open. */
const TALLY_KINDS = ['done', 'partly', 'not_yet', 'not_applicable', 'does_not_apply', 'scope_answered'] as const satisfies readonly StatusMarkKind[];

/**
 * A stage's tally from the loader's counts (lib/data/projects.ts), nothing new read. Every question of a stage is
 * gated (`notApplicableByGate`), or has no decision (`noDecision`), or has a status (`byStatus`), or is the gate itself
 * with an answer and no status (lib/ui/marks.ts): the loader counts the first three, so the answered gate is what is
 * left. Counts that over-add (they come from separate reads) give 0 answered, never a negative count.
 */
export function stageTally(c: StageCounts): Tally & Record<(typeof TALLY_KINDS)[number], number> & { doneNoEvidence: number } {
  const { done, partly, not_yet, not_applicable } = c.byStatus;
  const answered = c.questions - c.noDecision - c.notApplicableByGate - (done + partly + not_yet + not_applicable);
  return {
    done, partly, not_yet, not_applicable, does_not_apply: c.notApplicableByGate, scope_answered: Math.max(0, answered),
    doneNoEvidence: c.doneWithoutEvidence,
  };
}

/**
 * One stage of S-10 (FR-PRJ-02, UX-06; spec 9.2) as a plain block: its name, what is still open, what is recorded so
 * far, its stage reviews, then one link to the stage page. Counts are words and numerals, each stage on its own; no
 * percentage, bar or cross-stage total (FR-RM-04). The tally's words are the kit's (`tallyWords`); each item carries the
 * kit's shape, hidden from assistive technology, so a screen reader hears each item once. `children` (the follow-up)
 * lands under "Still open"; `reviews` (the stage reviews summary) after "Recorded so far".
 */
export function StageColumn(p: { orgSlug: string; projectId: string; stage: Stage; counts: StageCounts; children: ReactNode; reviews?: ReactNode }): ReactElement {
  const c = p.counts;
  const headingId = `${p.stage}-name`;
  const tally = stageTally(c);
  const kinds = TALLY_KINDS.filter((k) => tally[k] > 0);
  const nothingOpen = c.noDecision + c.openFindings + c.overdueMitigations + c.openMitigations === 0;
  const stillOpen: ReactNode[] = [];
  if (c.noDecision > 0) stillOpen.push(<li key="no-decision">{C.noDecisionQuestions(c.noDecision)}</li>);
  if (c.openFindings > 0) {
    stillOpen.push(
      <li key="findings">
        <ListLink href={`/orgs/${p.orgSlug}/projects/${p.projectId}/findings#g-${p.stage}`}>{plural(c.openFindings, C.openFinding, C.openFindings)}</ListLink>
        {c.openFindingsWithoutMitigation > 0 ? C.withoutMitigation(c.openFindingsWithoutMitigation) : null}
      </li>,
    );
  }
  if (c.overdueMitigations > 0) stillOpen.push(<li key="overdue">{plural(c.overdueMitigations, C.overdueMitigation, C.overdueMitigations)}</li>);
  return (
    <section className="stage-column" id={p.stage} data-stage={p.stage} aria-labelledby={headingId}>
      <h2 id={headingId}>{STAGE_NAME[p.stage]}</h2>
      <p>{STAGE_LINE[p.stage]}</p>
      <p>{plural(c.questions, C.question, C.questions)}</p>
      <h3>{C.stillOpen}</h3>
      {nothingOpen ? <p>{C.nothingOpen}</p> : stillOpen.length > 0 ? <ul>{stillOpen}</ul> : null}
      {p.children}
      <h3>{C.recorded}</h3>
      {kinds.length === 0 ? <p>{UI_COPY.tally.none}</p> : (
        <ul className="stage-column__tally" role="list">
          {kinds.map((k) => (
            <li key={k} className="stage-column__tally-item">
              <MarkShape kind={k} />
              <span>{tallyWords(k === 'done' ? { done: tally.done, doneNoEvidence: tally.doneNoEvidence } : { [k]: tally[k] })}</span>
            </li>
          ))}
        </ul>
      )}
      {c.acceptedRisks + c.documentsIssued > 0 ? (
        <p>{C.issued(plural(c.acceptedRisks, C.acceptedRisk, C.acceptedRisks), plural(c.documentsIssued, C.document, C.documents))}</p>
      ) : null}
      {p.reviews}
      <p>
        <ListLink href={`/orgs/${p.orgSlug}/projects/${p.projectId}/stages/${p.stage}`} aria-describedby={headingId}>{C.allQuestions}</ListLink>
      </p>
    </section>
  );
}
