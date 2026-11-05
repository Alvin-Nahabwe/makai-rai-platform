import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { idempotentWrite, requestDigest } from '@/lib/data/idempotency';
import { unarchiveProjectIn } from '@/lib/data/projects';
import { parseRequestIdBody } from '@/lib/data/members';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

const ROUTE = 'app/api/v1/orgs/[slug]/projects/[id]/unarchive/route.ts::POST';

/**
 * Contract route row 22: POST to unarchive a project (FR-PRJ-03). Gate `project:archive` (owner and admin), body
 * `RequestIdBody`, 204 the first time and on a replay (owner answer A1, receipt mode). The state check sits inside the
 * write, so a replay of a finished call finds its receipt first and answers 204, not 409. A project of another
 * organisation is not visible under row-level security and answers the coded 404.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'project:archive');
    const body = parseRequestIdBody(await readJsonBody(req));
    const digest = requestDigest({ path: { id }, body });
    await idempotentWrite(ctx, {
      table: 'request_receipts', route: ROUTE, requestId: body.requestId, digest, actorUserId: identity.userId,
      write: (tx) => unarchiveProjectIn(tx, id),
      receipt: () => ({ rowId: null }),
      replay: async () => undefined,
    });
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return toResponse(e);
  }
}
