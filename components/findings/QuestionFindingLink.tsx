import type { Stage } from '@/types/record';
import type { ReactElement } from 'react';
import { ListLink } from '@/components/ui/ListLink';

export type QuestionFindingLinkProps = { orgSlug: string; projectId: string; stage: Stage; questionId: string; currentVersionId: string | null; openFinding: { findingId: string } | null; canRaise: boolean };

/**
 * The link to the open finding of the question, and the link to raise one (UX-14, FR-FND-02). A slot of S-12 (contract
 * "Screens and slots"): the screen's owner renders it, FND-b fills it. "1 open finding from this question" with "Open finding"
 * when the question has an open shortfall finding (W-3 line 1859); "Raise a finding about this question" for a role that may
 * raise (reviewers and the roles above them), which opens S-14's form with the stage and the question filled in. Nothing for a
 * role that can do neither.
 */
export function QuestionFindingLink(p: QuestionFindingLinkProps): ReactElement | null {
  if (p.openFinding === null && !p.canRaise) return null;
  const base = `/orgs/${p.orgSlug}/projects/${p.projectId}/findings`;
  const query = new URLSearchParams({ raise: '1', stage: p.stage, questionId: p.questionId });
  if (p.currentVersionId !== null) query.set('versionId', p.currentVersionId);
  return (
    <div>
      {p.openFinding === null ? null : (
        <p>1 open finding from this question. <ListLink href={`${base}/${p.openFinding.findingId}`}>Open finding</ListLink></p>
      )}
      {p.canRaise ? <p><ListLink href={`${base}?${query.toString()}#raise`}>Raise a finding about this question</ListLink></p> : null}
    </div>
  );
}
