import { NextRequest, NextResponse } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { assertCurrentVersions, recordAcceptances } from '@/lib/data/acceptances';
import { ValidationFailed } from '@/lib/http/errors';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { isAcceptancePairs, type AcceptancePair } from '@/lib/legal/kinds';

/**
 * Contract route row 30 (FR-ACC-03, FR-ACC-04): POST `{ acceptances: [{ kind, version }] }` records
 * the signed-in account's acceptance of the current version of each kind (version and hash from
 * the registry, never from the body) and answers 204. Each posted `version` is the one the page
 * showed: one that is not current answers 409 `legal_text_changed` with M-39 and writes nothing
 * (threat A5). Reachable without the acceptances (gate 3 would otherwise block the one route that
 * clears it), so `allowMissingAcceptances: true`. A body whose `acceptances` is not a non-empty
 * list of pairs of the three accepted kinds answers 422 `validation` and writes nothing.
 */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const identity = await requireIdentityForApi({ allowMissingAcceptances: true });
    const body: unknown = await req.json().catch((e: unknown) => {
      if (e instanceof SyntaxError) return null;   // not JSON: refused below as a missing `kinds`
      throw e;
    });
    const acceptances = acceptancesOf(body);
    assertCurrentVersions(acceptances);
    await recordAcceptances(identity.userId, acceptances.map((a) => a.kind));
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return toResponse(e);
  }
}

function acceptancesOf(body: unknown): AcceptancePair[] {
  const acceptances = typeof body === 'object' && body !== null ? (body as { acceptances?: unknown }).acceptances : undefined;
  if (!isAcceptancePairs(acceptances) || acceptances.length === 0) {
    throw new ValidationFailed([{ field: 'acceptances', message: 'Choose one or more of terms, privacy and cross-border-consent, each with the version shown.' }]);
  }
  return acceptances;
}
