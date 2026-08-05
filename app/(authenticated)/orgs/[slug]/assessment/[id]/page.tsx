import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { can } from '@/lib/authz/policy';
import AssessmentPageClient from './AssessmentPageClient';

/**
 * D-129 fix (round 1: Reset Assessment + response inputs; round 2:
 * "Complete {stage}", StageSelector's "Start Again", and
 * QuickAssessment's inputs/submit): this server wrapper is the ONLY place
 * that reads the caller's role for this screen, from the membership row
 * via `requireOrgContextFor` — never from client input. The actual
 * assessment page (fetching, rendering, answering) stayed client-side
 * (`AssessmentPageClient.tsx`, accepting `canRespond`/`canComplete` and
 * threading them down to every gated control, including
 * `StageSelector`/`QuickAssessment`) because it already loads its data
 * over `fetch(apiBase)` from `GET /api/v1/orgs/[slug]/assessments/[id]`,
 * which is itself gated on `assessment:read` — every role holds that, so
 * gating THIS wrapper on `assessment:read` too (not `assessment:respond`)
 * is correct: a `reviewer`/`viewer` may still reach this screen to read
 * it, just not to mutate it. `assessment:respond`/`assessment:complete`
 * are derived here and passed down as plain boolean props, not re-derived
 * client-side, so there is exactly one authority for the decision
 * (`lib/authz/policy.ts#can`), matching this plan's reason for deleting
 * `lib/authz.ts` (ADR-0001: two authorities drift).
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
    />
  );
}
