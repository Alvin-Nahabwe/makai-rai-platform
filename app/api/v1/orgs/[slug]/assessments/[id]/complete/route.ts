import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { completeAssessment } from '@/lib/data/assessments';
import { toResponse } from '@/lib/http/toResponse';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * See `lib/data/assessments.ts#completeAssessment` for why the read of
 * `engineState` and the write of `status`/`reportData`/`overallScore` are
 * now inside one `withOrg` call (fix round 1, Important finding 3), and for
 * O-14's completion half (fix round 2, Critical): the `kind: 'drifted'`
 * case below.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'assessment:complete');

    const result = await completeAssessment(ctx, id);

    switch (result.kind) {
      case 'not_found':
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      case 'already_completed':
        return NextResponse.json(result.assessment);
      case 'no_stages':
        return NextResponse.json(
          { error: 'Complete at least one lifecycle stage before finishing the assessment' },
          { status: 400 },
        );
      case 'malformed_state':
        // 400 like `no_stages`, but its OWN message, and logged where
        // `no_stages` is not. Both distinctions are deliberate.
        //
        // The message, because these are different problems: `no_stages`
        // tells a user to go finish a stage, which is useless advice for a
        // corrupt state and would send them round a loop that cannot
        // terminate.
        //
        // The log, because reaching here means a structurally invalid
        // `engineState` is ALREADY STORED on this row. The PATCH route
        // refuses those at ingress, so this branch firing means one got in
        // before that guard existed, or by some path that does not go
        // through it -- worth a record either way. Until this change the
        // same input produced an uncaught TypeError, which `toResponse`
        // rethrows by design: an unlogged 500 with no security event at
        // all.
        logSecurityEvent('INPUT_VALIDATION_FAILURE', 'warn', {
          userId: identity.userId,
          details: { route: 'assessment:complete', assessmentId: id, reason: 'malformed_engine_state' },
        });
        return NextResponse.json(
          {
            error:
              'This assessment\'s saved state is not readable, so it cannot be completed. ' +
              'It cannot be repaired from the assessment page — start a new assessment for this project instead.',
          },
          { status: 400 },
        );
      // The wording above is constrained by what the product can actually
      // do, which is narrower than it first appears (code-review lens,
      // 2026-08-26). The obvious advice -- "reopen the assessment and save
      // your answers again" -- is FALSE, and falsest precisely here: the
      // PATCH ingress guard added in this same change refuses any save
      // whose `engineState` fails `hasWellFormedStages`, so a client
      // re-saving the corrupt state it just loaded is refused, and
      // `autoSave` does not read the status (AssessmentPageClient.tsx,
      // D-130) so the user would not even be told. Telling someone to
      // perform an action the same commit made impossible is worse than
      // saying nothing. Creating a fresh assessment IS available -- it
      // writes a server-generated `createAssessment()` state
      // (app/api/v1/orgs/[slug]/assessments/route.ts) that cannot be
      // malformed -- so that is what the message names.
      case 'drifted':
        // 409, matching every other O-14 drift refusal in this codebase
        // (the PATCH route, the evidence upload route) — the request
        // conflicts with the assessment's current pinned/deployed-content
        // state. A message distinct from every OTHER case in this switch,
        // for the same reason Task 6 (task-6-report.md) and fix round 1
        // both required it: a shared message made a deleted guard
        // untestable.
        return NextResponse.json(
          {
            error:
              'Framework content has drifted since this assessment was pinned; ' +
              'this assessment cannot be completed until the deployed content matches its pinned version again',
          },
          { status: 409 },
        );
      case 'completed':
        logSecurityEvent('ASSESSMENT_COMPLETED', 'info', {
          userId: identity.userId,
          details: { assessmentId: id, overallScore: result.overallScore },
        });
        return NextResponse.json(result.assessment);
      default: {
        // Exhaustiveness guard (fix round 2): this switch previously had no
        // `default`, so an unhandled `CompleteResult` kind would fall
        // through and return nothing at all — precisely the class of bug a
        // missing `'drifted'` case here would otherwise have been silently.
        const _exhaustive: never = result;
        throw new Error(`assessment complete: unhandled outcome ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (e) {
    return toResponse(e);
  }
}
