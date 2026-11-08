import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { assertSealOfReview, checkSeal } from '@/lib/data/seals';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 14: check a seal (FR-REV-06, UX-19). Every member may check (`record:read`; call U11): no
 * session 401, not a member 404. The seal must belong to the review and the review to the project, else 404, as for a
 * seal of another organisation (obligation A3). 200 with the `SealCheckResult`. A read: no request id (UX-27).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string; id: string; reviewId: string; sealId: string }> }) {
  const { slug, id, reviewId, sealId } = await params;
  try {
    const { ctx } = await requireOrgContextWithIdentity(slug, 'record:read');
    await assertSealOfReview(ctx, id, reviewId, sealId);
    return NextResponse.json(await checkSeal(ctx, sealId), { status: 200 });
  } catch (e) {
    return toResponse(e);
  }
}
