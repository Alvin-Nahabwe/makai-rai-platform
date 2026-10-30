import { NextRequest } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { NotImplementedError } from '@/lib/http/errors';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 18: GET to read an issued document as text. A gated stub until DOC-b merges
 * (PENDING_ROUTES in lib/authz/routeActions.ts): it refuses a caller with no session (401), no
 * membership of the organisation (404) or a role without `record:read` (403), and only then answers
 * 501.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string; documentId: string }> }) {
  const { slug } = await params;
  try {
    await requireOrgContextWithIdentity(slug, 'record:read');
    throw new NotImplementedError('DOC-b');
  } catch (e) {
    return toResponse(e);
  }
}
