import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { can } from '@/lib/authz/policy';
import AssessmentPageClient from './AssessmentPageClient';

/**
 * D-129 fix (round 1: Reset Assessment + response inputs; round 2:
 * "Complete {stage}" and StageSelector's "Start Again"): this server wrapper is the ONLY place
 * that reads the caller's role for this screen, from the membership row
 * via `requireOrgContextFor` — never from client input. The actual
 * assessment page (fetching, rendering, answering) stayed client-side
 * (`AssessmentPageClient.tsx`, accepting `canRespond`/`canComplete` and
 * threading them down to every gated control, including
 * `StageSelector`) because it already loads its data
 * over `fetch(apiBase)` from `GET /api/v1/orgs/[slug]/assessments/[id]`,
 * which is itself gated on `assessment:read` — every role holds that, so
 * gating THIS wrapper on `assessment:read` too (not `assessment:respond`)
 * is correct: a `reviewer`/`viewer` may still reach this screen to read
 * it, just not to mutate it. `assessment:respond`/`assessment:complete`
 * are derived here and passed down as plain boolean props, not re-derived
 * client-side, so there is exactly one authority for the decision
 * (`lib/authz/policy.ts#can`), matching this plan's reason for deleting
 * `lib/authz.ts` (ADR-0001: two authorities drift).
 *
 * Task 10 adds `canCreateEvidence`/`canDeleteEvidence`, the SAME shape:
 * derived here from `ctx.role`, never re-derived client-side. Not in that
 * task's own brief file list (which named only `AssessmentPageClient.tsx`,
 * `QuestionBlock.tsx`, a new `EvidenceAttach.tsx` and the e2e spec) — but
 * `AssessmentPageClient` cannot gate on `evidence:create`/`evidence:delete`
 * without a server-derived boolean from somewhere, and this file is the
 * only place this screen reads a role at all (this comment's own first
 * sentence). Flagged as a brief gap in task-10-report.md.
 */
export default async function AssessmentPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'assessment:read');

  return (
    <AssessmentPageClient
      canRespond={can(ctx.role, 'assessment:respond')}
      canComplete={can(ctx.role, 'assessment:complete')}
      canCreateEvidence={can(ctx.role, 'evidence:create')}
      canDeleteEvidence={can(ctx.role, 'evidence:delete')}
    />
  );
}
