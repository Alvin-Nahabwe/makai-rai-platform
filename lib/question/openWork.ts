import { NotFoundError, withOrg, type OrgContext } from '@/lib/data/tenant';
import { decisionHistory } from '@/lib/data/decisions';
import { listFindings } from '@/lib/data/findings';
import { projectFollowUp } from '@/lib/data/followup';
import { loadContent } from '@/lib/content/loader';
import { compareFollowUp } from '@/lib/followup/rules';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import type { CalendarDate, Stage } from '@/types/record';
import type { DecisionVersionView, FindingView } from '@/types/api';

/**
 * What is still open on one question, for the read-only question page (plan 1C Task 7; decision C12): its open findings,
 * oldest raised first, each with its open mitigations in the follow-up order (FR-FUP-01), an empty list for "No
 * mitigation yet". SERVER ONLY, like lib/question/panel.ts: the question page, a server component, calls it.
 *
 * Holds only what the findings pages show every role with `record:read` (obligation S4): the finding's id and the name the
 * findings list gives it, and per open mitigation its text, the assigned person's name, the due date, overdue and the
 * status. Mapped field by field; no user id, email, description or raw row.
 */
export type QuestionOpenWork = {
  findings: Array<{
    findingId: string; title: string;
    mitigations: Array<{ what: string | null; assignedTo: string; dueDate: CalendarDate; overdue: boolean; status: 'planned' | 'in_progress' }>;
  }>;
};

/**
 * The name S-14 gives a finding (lib/findings/pageData.ts `titleOf`): a team finding its own title, or "Untitled finding";
 * a shortfall finding the question's text in the content version of the decision version it was raised from, or the
 * question id when that version is not found.
 */
function titleOf(f: FindingView, versions: ReadonlyMap<string, DecisionVersionView>): string {
  if (f.source === 'team') return f.title ?? FINDINGS_COPY.finding.untitled;
  if (f.questionId === null) return FINDINGS_COPY.finding.untitled;
  const version = f.decisionVersionId === null ? undefined : versions.get(f.decisionVersionId);
  const text = version === undefined ? undefined : loadContent(version.content.semver as never).questions.get(f.questionId)?.text;
  return text ?? f.questionId;
}

/**
 * `NotFoundError` for a project that is not this organisation's or does not exist, before anything else is read
 * (NFR-SEC-02; obligation S3). Every read runs in `withOrg` (obligation S1): the project check here, and the data layer's
 * `listFindings`, `projectFollowUp` and `decisionHistory`.
 */
export async function loadQuestionOpenWork(
  ctx: OrgContext, p: { projectId: string; stage: Stage; questionId: string; today: CalendarDate },
): Promise<QuestionOpenWork> {
  const project = await withOrg(ctx, (tx) => tx.project.findFirst({ where: { id: p.projectId }, select: { id: true } }));
  if (project === null) throw new NotFoundError();

  const findings = (await listFindings(ctx, p.projectId, p.stage, p.today))
    .filter((f) => f.questionId === p.questionId && f.state === 'open');
  if (findings.length === 0) return { findings: [] };

  const [followUp, history] = await Promise.all([
    projectFollowUp(ctx, p.projectId, p.today, { includeArchived: true }),
    findings.some((f) => f.source !== 'team' && f.decisionVersionId !== null) ? decisionHistory(ctx, p.projectId, p.questionId) : [],
  ]);
  const versions = new Map(history.map((v) => [v.id, v]));
  const open = followUp.open[p.stage];

  return {
    findings: findings.map((f) => ({
      findingId: f.id,
      title: titleOf(f, versions),
      mitigations: open.filter((m) => m.findingId === f.id).sort(compareFollowUp).map((m) => ({
        what: m.what, assignedTo: m.owner.name, dueDate: m.dueDate, overdue: m.overdue, status: m.status,
      })),
    })),
  };
}
