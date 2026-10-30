import { NextRequest, NextResponse } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { recordAcceptances } from '@/lib/data/acceptances';
import { ValidationFailed } from '@/lib/http/errors';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { ACCEPTED_KINDS, type AcceptedKind } from '@/types/legal';

/**
 * Contract route row 30 (FR-ACC-03, FR-ACC-04): POST `{ kinds }` records the signed-in account's
 * acceptance of the current version of each kind (version and hash from the registry, never from
 * the body) and answers 204. Reachable without the acceptances (gate 3 would otherwise block the
 * one route that clears it), so `allowMissingAcceptances: true`. A body whose `kinds` is not a
 * non-empty array of the three accepted kinds answers 422 `validation` and writes nothing.
 */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const identity = await requireIdentityForApi({ allowMissingAcceptances: true });
    const body: unknown = await req.json().catch((e: unknown) => {
      if (e instanceof SyntaxError) return null;   // not JSON: refused below as a missing `kinds`
      throw e;
    });
    const kinds = acceptedKinds(body);
    await recordAcceptances(identity.userId, kinds);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return toResponse(e);
  }
}

function acceptedKinds(body: unknown): AcceptedKind[] {
  const kinds = typeof body === 'object' && body !== null ? (body as { kinds?: unknown }).kinds : undefined;
  if (!Array.isArray(kinds) || kinds.length === 0
    || !kinds.every((k): k is AcceptedKind => typeof k === 'string' && (ACCEPTED_KINDS as readonly string[]).includes(k))) {
    throw new ValidationFailed([{ field: 'kinds', message: 'Choose one or more of terms, privacy and cross-border-consent.' }]);
  }
  return kinds;
}
