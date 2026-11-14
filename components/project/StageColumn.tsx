import './StageView.css';
import type { ReactElement, ReactNode } from 'react';
import type { StageCounts } from '@/types/api';
import type { Stage } from '@/types/record';
import { ListLink } from '@/components/ui/ListLink';
import { PROJECT_COPY } from '@/lib/project/copy';

/** The stage names and the line under each (SRS W-1), read from the project screens' copy module. */
export const STAGE_NAME: Readonly<Record<Stage, string>> = PROJECT_COPY.stageNames;
export const STAGE_LINE: Readonly<Record<Stage, string>> = PROJECT_COPY.stageLines;

const C = PROJECT_COPY.stage;

/** "1 question", "2 questions". */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One stage of S-10 (FR-PRJ-02, UX-06): to-do counts first, then recorded counts, in words and numerals; no
 * percentage, bar or cross-stage total (FR-RM-04). A `<details open>`: the collapsed heading still shows its three
 * to-do counts, and its text stays findable (modern-web-guidance `search-hidden-content`). The four status phrases
 * carry `status-label` and no warning class (UX-06); the slots for follow-up and stage reviews come in as children.
 */
export function StageColumn(p: { orgSlug: string; projectId: string; stage: Stage; counts: StageCounts; children: ReactNode }): ReactElement {
  const c = p.counts;
  const name = STAGE_NAME[p.stage];
  const notApplicable = c.byStatus.not_applicable + c.notApplicableByGate;
  const nothingRecorded = c.byStatus.done + c.byStatus.partly + c.byStatus.not_yet + notApplicable + c.acceptedRisks + c.documentsIssued === 0;
  const noMitigationNote = c.openFindingsWithoutMitigation > 0 ? C.withoutMitigation(c.openFindingsWithoutMitigation) : '';
  const openFindings = plural(c.openFindings, C.openFinding, C.openFindings);
  const overdueMitigations = plural(c.overdueMitigations, C.overdueMitigation, C.overdueMitigations);
  return (
    <details open className="stage-column" id={p.stage} data-stage={p.stage}>
      <summary>
        <h2>{name}</h2>
        <span className="stage-column__todo-line">
          {C.todoLine(name, c.noDecision, openFindings, overdueMitigations)}
        </span>
      </summary>
      <p>{STAGE_LINE[p.stage]}</p>
      <p>{plural(c.questions, C.question, C.questions)}</p>
      <h3>{C.todo}</h3>
      <ul>
        <li>{C.noDecision(c.noDecision)}</li>
        <li>{`${openFindings}${noMitigationNote}`}</li>
        <li>{overdueMitigations}</li>
        <li>{C.doneNoEvidence(c.doneWithoutEvidence)}</li>
      </ul>
      <h3>{C.recorded}</h3>
      {nothingRecorded ? <p>{C.nothingRecorded}</p> : (
        <>
          <ul>
            <li><span className="status-label">{C.done(c.byStatus.done)}</span></li>
            <li><span className="status-label">{C.partly(c.byStatus.partly)}</span></li>
            <li><span className="status-label">{C.notYet(c.byStatus.not_yet)}</span></li>
            <li><span className="status-label">{C.notApplicable(notApplicable)}</span></li>
          </ul>
          <p>{C.issued(plural(c.acceptedRisks, C.acceptedRisk, C.acceptedRisks), plural(c.documentsIssued, C.document, C.documents))}</p>
        </>
      )}
      <p><ListLink href={`/orgs/${p.orgSlug}/projects/${p.projectId}/stages/${p.stage}`}>{C.open(p.stage)}</ListLink></p>
      {p.children}
    </details>
  );
}
