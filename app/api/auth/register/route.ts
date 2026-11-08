import { NextRequest, NextResponse } from 'next/server';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * The open sign-up route, removed (FR-ACC-01, SRS line 473: "the response is 404 and no user row
 * is created"). An account is created only from an invitation (route 31). The file stays as a 404
 * because deleting it is not enough: the NextAuth catch-all `app/api/auth/[...nextauth]/route.ts`
 * then answers `/api/auth/register` itself, with 400 "Bad request." (measured with `next start`,
 * 2026-10-30). It reads no setting and writes nothing; a write method still refuses a cross-origin
 * request first, as every write route does (NFR-SEC-08).
 */
function notFound(): NextResponse {
  return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
}

function refuseWrite(req: NextRequest): NextResponse {
  try {
    assertSameOrigin(req);
    return notFound();
  } catch (e) {
    return toResponse(e);
  }
}

export function GET(): NextResponse {
  return notFound();
}
export const POST = refuseWrite;
export const PUT = refuseWrite;
export const PATCH = refuseWrite;
export const DELETE = refuseWrite;
