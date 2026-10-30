import { NextRequest } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { NotImplementedError } from '@/lib/http/errors';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 8: POST to accept a risk. A gated stub until FND-a merges (PENDING_ROUTES in
 * lib/authz/routeActions.ts): it refuses a cross-origin request, then a caller with no session (401),
 * no membership of the organisation (404) or a role without `risk:accept` (403), and only then answers
 * 501.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string; findingId: string }> }) {
  const { slug } = await params;
  try {
    assertSameOrigin(req);
    await requireOrgContextWithIdentity(slug, 'risk:accept');
    throw new NotImplementedError('FND-a');
  } catch (e) {
    return toResponse(e);
  }
}
