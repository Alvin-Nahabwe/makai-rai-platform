import { Prisma, type Assessment } from '@prisma/client';
import { withOrg, type OrgContext } from './tenant';
import { generateReportData, canGenerateReport } from '../engine/AssessmentEngine.js';
import { getQuickScore } from '../engine/QuickAssessment.js';
import type { EngineState } from '../../types/domain';

/** Shape persisted for a quick assessment (no lifecycle stages). */
interface QuickState {
  mode: 'quick';
  quick: { responses: Record<string, number> };
}

export type RespondResult =
  | { kind: 'not_found' }
  | { kind: 'completed' }
  | { kind: 'updated'; assessment: Assessment };

/**
 * The core logic behind `PATCH /api/v1/orgs/[slug]/assessments/[id]`
 * (the assessment page's debounced autoSave). Extracted so it is testable
 * without a NextAuth session/cookie in the loop, mirroring
 * `lib/data/members.ts#removeMember`.
 *
 * Fix round 1, Important finding 3: the immutability check and the
 * `engineState` write used to be TWO separate `withOrg` calls (two
 * transactions). A concurrent `POST .../complete` could land between them
 * — this function would read `status: 'in_progress'`, the concurrent
 * request would commit `completed` + `reportData`, and this function's
 * write would still proceed, silently mutating `engineState` on an
 * assessment that now reads as completed. Fixed by reading and writing
 * inside ONE `withOrg` callback, so both statements share a transaction —
 * covered by `__tests__/integration/assessments.test.ts`, which asserts
 * `withOrg` is invoked exactly once per call (it was invoked twice before
 * this fix).
 */
export async function respondToAssessment(
  ctx: OrgContext,
  id: string,
  engineState: Prisma.InputJsonValue,
): Promise<RespondResult> {
  return withOrg(ctx, async (tx) => {
    const existing = await tx.assessment.findUnique({ where: { id }, select: { status: true } });
    if (!existing) return { kind: 'not_found' };

    // A completed assessment is immutable — its score is a record of a
    // point in time. Reject edits rather than silently letting the report
    // drift.
    if (existing.status === 'completed') return { kind: 'completed' };

    const assessment = await tx.assessment.update({ where: { id }, data: { engineState } });
    return { kind: 'updated', assessment };
  });
}

export type CompleteResult =
  | { kind: 'not_found' }
  | { kind: 'already_completed'; assessment: Assessment }
  | { kind: 'no_responses' }
  | { kind: 'no_stages' }
  | { kind: 'completed'; assessment: Assessment; mode: 'quick' | 'full'; overallScore: number };

/**
 * The core logic behind `POST /api/v1/orgs/[slug]/assessments/[id]/complete`.
 * Extracted for the same reason and covered by the same test file as
 * `respondToAssessment` above.
 *
 * Fix round 1, Important finding 3: the read of `engineState` and the
 * write of `status`/`reportData`/`overallScore` used to be two SEPARATE
 * `withOrg` transactions. Between them, a concurrent autoSave PATCH could
 * commit a NEWER `engineState`, and this function's write — computed from
 * the OLDER `engineState` it read earlier — would still land, producing a
 * completed assessment whose cached `reportData` no longer matches its own
 * `engineState`. Fixed by moving the read, score computation, and write
 * inside ONE `withOrg` callback. Score computation is synchronous/pure (no
 * extra I/O), so this does not reintroduce the D-065 "CPU-bound work
 * holding a pooled connection" concern the PDF route's fetch-then-render
 * split exists for.
 */
export async function completeAssessment(ctx: OrgContext, id: string): Promise<CompleteResult> {
  return withOrg(ctx, async (tx) => {
    const assessment = await tx.assessment.findUnique({ where: { id } });
    if (!assessment) return { kind: 'not_found' };

    // Idempotency: a completed assessment keeps its original score/report.
    if (assessment.status === 'completed') {
      return { kind: 'already_completed', assessment };
    }

    // Quick assessments use the curated 10-question engine, not lifecycle stages.
    if (assessment.mode === 'quick') {
      const quickState = assessment.engineState as unknown as QuickState;
      const responses = quickState?.quick?.responses ?? {};
      if (Object.keys(responses).length === 0) {
        return { kind: 'no_responses' };
      }
      const overallScore = getQuickScore(responses);
      const updated = await tx.assessment.update({
        where: { id },
        data: {
          status: 'completed',
          reportData: {
            mode: 'quick',
            overallScore,
            completedStages: [],
            generatedAt: new Date().toISOString(),
          } as unknown as Prisma.InputJsonValue,
          overallScore,
          completedAt: new Date(),
        },
      });
      return { kind: 'completed', assessment: updated, mode: 'quick', overallScore };
    }

    // Score is computed server-side from the persisted engine state so it
    // cannot be forged by the client. Require at least one completed stage.
    const engineState = assessment.engineState as unknown as EngineState;
    if (!canGenerateReport(engineState)) {
      return { kind: 'no_stages' };
    }

    const reportData = generateReportData(engineState);
    const updated = await tx.assessment.update({
      where: { id },
      data: {
        status: 'completed',
        reportData: reportData as unknown as Prisma.InputJsonValue,
        overallScore: Math.round(reportData.overallScore),
        completedAt: new Date(),
      },
    });
    return { kind: 'completed', assessment: updated, mode: 'full', overallScore: updated.overallScore ?? 0 };
  });
}
