import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContext } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { respondToAssessment } from '@/lib/data/assessments';
import { EVIDENCE_COUNT_INCLUDE, withDerivedEvidenceLevel } from '@/lib/data/evidence';
import { resolveFramework } from '@/lib/data/framework';
import { toResponse } from '@/lib/http/toResponse';

/**
 * O-15/O-14 (Plan 1c Task 9): not the brief's own file list either — same
 * "reach" reasoning as the `EVIDENCE_COUNT_INCLUDE` comment two lines below,
 * for a different field. `report/page.tsx` (the client report page) is the
 * ONLY consumer of this route that needs provenance data, but every caller
 * of `GET .../assessments/[id]` receives it — there is no cheaper, equally
 * safe way to reach a 'use client' component than through the JSON this
 * route already returns, and `framework_versions` carries no tenant
 * secrets (Task 1: global, read-mostly content metadata) so there is
 * nothing to gate this field behind.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    const ctx = await requireOrgContext(slug, 'assessment:read');
    const { assessment, resolution } = await withOrg(ctx, async (tx) => {
      const assessment = await tx.assessment.findUnique({
        where: { id },
        include: {
          project: { select: { name: true, id: true } },
          // O-20: not the brief's own file list, but the same obligation —
          // this is the SECOND of four places a RemediationItem reaches a
          // client (remediation GET/PATCH being the other two, plus the
          // project-detail route). evidenceLevel is not a stored column;
          // every one of the four must derive it fresh via
          // `withDerivedEvidenceLevel`, or the SAME item would show a
          // DIFFERENT evidenceLevel depending on which endpoint served it.
          remediationItems: { include: EVIDENCE_COUNT_INCLUDE },
        },
      });
      if (!assessment) return { assessment: null, resolution: null };

      const resolution = await resolveFramework(id, tx);
      // Same "not believed reachable, fail closed anyway" posture as the
      // evidence upload route (app/api/v1/orgs/[slug]/assessments/[id]/
      // evidence/route.ts) and the sibling PDF route
      // (app/api/v1/orgs/[slug]/reports/[id]/pdf/route.ts) take for the
      // identical situation: `resolution` reads the SAME row, in the SAME
      // transaction, that the findUnique above just proved exists.
      if (!resolution) {
        throw new Error(
          `resolveFramework returned null for assessment ${id} despite it resolving moments earlier in the same transaction`,
        );
      }
      return { assessment, resolution };
    });
    if (!assessment || !resolution) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({
      ...assessment,
      remediationItems: assessment.remediationItems.map(withDerivedEvidenceLevel),
      framework: {
        semver: resolution.pinned.semver,
        contentHash: resolution.pinned.contentHash,
        matches: resolution.matches,
      },
    });
  } catch (e) {
    return toResponse(e);
  }
}

/**
 * See `lib/data/assessments.ts#respondToAssessment` for why the
 * immutability check and the write are now inside one `withOrg` call
 * (fix round 1, Important finding 3).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    const ctx = await requireOrgContext(slug, 'assessment:respond');

    const body = await req.json();
    const { engineState } = body;
    // Accept either a full lifecycle state (has `stages`) or a quick-check
    // state (has `quick`). Anything else is malformed.
    if (!engineState || typeof engineState !== 'object' || (!engineState.stages && !engineState.quick)) {
      return NextResponse.json({ error: 'A valid engineState is required' }, { status: 400 });
    }

    const result = await respondToAssessment(ctx, id, engineState);

    if (result.kind === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (result.kind === 'completed') {
      return NextResponse.json({ error: 'Completed assessments cannot be modified' }, { status: 409 });
    }
    return NextResponse.json(result.assessment);
  } catch (e) {
    return toResponse(e);
  }
}
