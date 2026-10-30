import { NextRequest } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { NotImplementedError } from '@/lib/http/errors';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 20: GET to export the organisation or one project. A gated stub until EXP merges
 * (PENDING_ROUTES in lib/authz/routeActions.ts): it refuses a caller with no session (401), no
 * membership of the organisation (404) or a role without `team:export` (403), and only then answers
 * 501.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    await requireOrgContextWithIdentity(slug, 'team:export');
    throw new NotImplementedError('EXP');
  } catch (e) {
    return toResponse(e);
  }
}
