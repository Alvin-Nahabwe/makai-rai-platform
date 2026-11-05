import './StageView.css';
import type { ReactElement, ReactNode } from 'react';
import type { StageCounts } from '@/types/api';
import type { Stage } from '@/types/record';
import { ListLink } from '@/components/ui/ListLink';

/** The stage names and the line under each (SRS W-1). */
export const STAGE_NAME: Record<Stage, string> = {
  'pre-processing': 'Pre-processing', 'in-processing': 'In-processing', 'post-processing': 'Post-processing',
};
const STAGE_LINE: Record<Stage, string> = {
  'pre-processing': 'Problem formulation; data collection and preparation',
  'in-processing': 'Model development and training; evaluation, fairness, documentation',
  'post-processing': 'Deployment and monitoring; governance and community engagement',
};

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
  const noMitigationNote = c.openFindingsWithoutMitigation > 0 ? ` (${c.openFindingsWithoutMitigation} of them with no mitigation yet)` : '';
  return (
    <details open className="stage-column" id={p.stage} data-stage={p.stage}>
      <summary>
        <h2>{name}</h2>
        <span className="stage-column__todo-line">
          {`${name}: ${c.noDecision} with no decision, ${plural(c.openFindings, 'open finding', 'open findings')}, ${plural(c.overdueMitigations, 'overdue mitigation', 'overdue mitigations')}`}
        </span>
      </summary>
      <p>{STAGE_LINE[p.stage]}</p>
      <p>{plural(c.questions, 'question', 'questions')}</p>
      <h3>To do</h3>
      <ul>
        <li>{`${c.noDecision} with no decision`}</li>
        <li>{`${plural(c.openFindings, 'open finding', 'open findings')}${noMitigationNote}`}</li>
        <li>{plural(c.overdueMitigations, 'overdue mitigation', 'overdue mitigations')}</li>
        <li>{`${c.doneWithoutEvidence} done without evidence`}</li>
      </ul>
      <h3>Recorded</h3>
      {nothingRecorded ? <p>Nothing recorded yet.</p> : (
        <>
          <ul>
            <li><span className="status-label">{`Done ${c.byStatus.done}`}</span></li>
            <li><span className="status-label">{`Partly ${c.byStatus.partly}`}</span></li>
            <li><span className="status-label">{`Not yet ${c.byStatus.not_yet}`}</span></li>
            <li><span className="status-label">{`Not applicable ${notApplicable}`}</span></li>
          </ul>
          <p>{`${plural(c.acceptedRisks, 'accepted risk', 'accepted risks')}, ${plural(c.documentsIssued, 'document', 'documents')} issued`}</p>
        </>
      )}
      <p><ListLink href={`/orgs/${p.orgSlug}/projects/${p.projectId}/stages/${p.stage}`}>{`Open ${p.stage}`}</ListLink></p>
      {p.children}
    </details>
  );
}
