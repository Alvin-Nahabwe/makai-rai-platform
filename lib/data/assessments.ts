import { Prisma, type Assessment } from '@prisma/client';
import { withOrg, type OrgContext } from './tenant';
import {
  generateReportData,
  canGenerateReport,
  hasWellFormedStages,
} from '../engine/AssessmentEngine.js';
import { resolveFramework } from './framework';
import type { EngineState } from '../../types/domain';

export type RespondResult =
  | { kind: 'not_found' }
  | { kind: 'completed' }
  | { kind: 'drifted' }
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
 *
 * Plan 1c Task 9, fix round 1 (D-165, coordinator-authorised): O-14's
 * in-progress half -- design spec §4.1, "In-progress → stop accepting
 * answers. Continuing means one response set spanning two versions of the
 * same question — silent corruption no later check could untangle." Task 6
 * discharged this obligation only on the EVIDENCE upload route
 * (`app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts`, `kind:
 * 'drifted'`); uploading an artifact is not answering a question, and THIS
 * function -- the one write path that actually appends to `engineState` --
 * is where the corruption the spec describes would occur. `resolveFramework`
 * is called in the SAME `withOrg` transaction as the read/write above, not a
 * second one (requirement carried over from the Important-3 fix this doc
 * comment already describes).
 *
 * Checked AFTER the 'completed' branch, not before or unconditionally (a
 * deliberate difference from the evidence route's own ordering, where
 * `resolveFramework` runs first because `createEvidence` separately needs
 * `resolution.pinned.id` -- no equivalent need exists here): once an
 * assessment is completed, O-24's immutability is the controlling, simpler
 * reason a write is refused, independent of drift, and reporting "drift"
 * instead would incorrectly suggest that reconciling the content would
 * re-open editing, which completion itself already forecloses.
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

    // O-14, in-progress half. `resolution` reads the SAME assessment row,
    // inside the SAME transaction/snapshot, that the findUnique above just
    // proved exists — not believed reachable (same posture the evidence
    // upload route and Task 9's own two routes take for the identical
    // situation), but failing closed rather than trusting that belief.
    const resolution = await resolveFramework(id, tx);
    if (!resolution) {
      throw new Error(
        `resolveFramework returned null for assessment ${id} despite it resolving moments earlier in the same transaction`,
      );
    }
    if (!resolution.matches) return { kind: 'drifted' };

    const assessment = await tx.assessment.update({ where: { id }, data: { engineState } });
    return { kind: 'updated', assessment };
  });
}

export type CompleteResult =
  | { kind: 'not_found' }
  | { kind: 'already_completed'; assessment: Assessment }
  | { kind: 'no_stages' }
  // Distinct from `no_stages` on purpose: that one means "you have not
  // finished a stage yet" and is user-actionable, this one means "the
  // stored state is structurally unusable" and is not. Merging them would
  // put one message on two different refusals, which is what made Task 6's
  // two 409s untestable -- deleting either guard left the suite green.
  | { kind: 'malformed_state' }
  | { kind: 'drifted' }
  | { kind: 'completed'; assessment: Assessment; overallScore: number };

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
 *
 * Plan 1c Task 9, fix round 2 (Critical, coordinator-found and
 * independently verified before fixing): THIS function, not
 * `respondToAssessment`, is where O-14's in-progress corruption actually
 * lands. `generateReportData` (`lib/engine/AssessmentEngine.js:20-22`)
 * scores against WHATEVER CONTENT IS CURRENTLY DEPLOYED — never against the
 * pin. Fix round 1 closed the PATCH path (answers can no longer be added
 * once drifted) but left THIS path wide open: an assessment fully answered
 * while content matched can still be completed after content drifts, and
 * completion would score the stored `engineState` against the NEWER
 * content, cache that mismatched result as `reportData`, and O-24 then
 * makes it immutable — exactly "one response set spanning two versions of
 * the same question" (design spec §4.1), reached through a second write
 * path the original D-165 scoping missed entirely.
 *
 * Checked BEFORE the scoring dispatch below, unconditionally. Checked AFTER
 * `already_completed`, for the same reason `respondToAssessment` checks
 * `'completed'` before drift: a completed assessment is already immutable
 * and idempotent regardless of what the CURRENTLY deployed content looks
 * like now — there is nothing to gate.
 */
export async function completeAssessment(ctx: OrgContext, id: string): Promise<CompleteResult> {
  return withOrg(ctx, async (tx) => {
    const assessment = await tx.assessment.findUnique({ where: { id } });
    if (!assessment) return { kind: 'not_found' };

    // Idempotency: a completed assessment keeps its original score/report.
    if (assessment.status === 'completed') {
      return { kind: 'already_completed', assessment };
    }

    // O-14, completion half. `resolution` reads the SAME assessment row,
    // inside the SAME transaction/snapshot, that the findUnique above just
    // proved exists — not believed reachable (same posture every other
    // O-14 check in this codebase takes for the identical situation), but
    // failing closed rather than trusting that belief.
    const resolution = await resolveFramework(id, tx);
    if (!resolution) {
      throw new Error(
        `resolveFramework returned null for assessment ${id} despite it resolving moments earlier in the same transaction`,
      );
    }
    if (!resolution.matches) return { kind: 'drifted' };

    // Score is computed server-side from the persisted engine state so it
    // cannot be forged by the client. Require at least one completed stage.
    const engineState = assessment.engineState as unknown as EngineState;

    // Structural check FIRST, and separately from `canGenerateReport`,
    // for two reasons that both survive future edits to that function.
    //
    // (1) `generateReportData` (AssessmentEngine.js) still indexes
    //     `state.stages[<stage>].status` with NO guard of its own, and it
    //     runs below. `engineState` is a `Prisma.JsonValue` this function
    //     has only CAST to `EngineState` -- nothing has proven the shape --
    //     so something must check it before that call, and
    //     `hasWellFormedStages` is the engine's own precondition, so the
    //     answer cannot drift from what the engine actually requires.
    // (2) `canGenerateReport` can only answer a BOOLEAN, so even now that
    //     it is itself guarded it cannot distinguish "this state is
    //     corrupt" from "no stage is finished yet" -- and those are
    //     different refusals with different messages. Calling it alone
    //     would collapse them.
    //
    // Reason (2) is the load-bearing one: an earlier draft of this comment
    // justified the check by saying BOTH calls below were unguarded, which
    // the same change that wrote it had already made false.
    //
    // This is the second of two guards, and it is not redundant with the
    // first. The PATCH route refuses a malformed state at ingress, which
    // stops NEW ones being stored; this one covers rows already written --
    // by any writer, before this fix or after -- because the crash and the
    // request that caused it are two different requests apart. Without it,
    // one bad autosave permanently bricks completion for that assessment
    // with an uncaught, unlogged 500.
    if (!hasWellFormedStages(engineState)) {
      return { kind: 'malformed_state' };
    }
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
        // Read off `reportData` rather than importing `SCORING_VERSION`
        // separately (Task 6, maturity-band-reanchor): the column must equal
        // the cached blob, and taking both from one source makes them unable
        // to disagree. Write-once at the database via
        // trg_assessments_scoring_version_write_once
        // (20260826150000_add_assessment_scoring_version).
        scoringVersion: reportData.scoringVersion,
        completedAt: new Date(),
      },
    });
    return { kind: 'completed', assessment: updated, overallScore: updated.overallScore ?? 0 };
  });
}
