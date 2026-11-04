import { NextRequest } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { deleteAccount } from '@/lib/data/export';
import { ValidationFailed } from '@/lib/http/errors';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Route 39 (00-contract.md, Routes row 39; FR-EXP-03, UX-29): DELETE the signed-in account, with the
 * current password and the typed phrase `DELETE MY ACCOUNT` in the body `{ password, phrase }`.
 * 204 on deletion; 422 `validation` on `password` or `phrase` with the S-21 texts; 409
 * `last_active_owner` with `organisation` and the M-38 sentence. The work is `deleteAccount`
 * (lib/data/export.ts).
 *
 * Gated with `allowMissingAcceptances: true` (G028): a person who has not accepted the current legal
 * texts can still delete their account (FR-ACC-04, SRS line 491). The origin check comes first
 * (NFR-SEC-08).
 */
export async function DELETE(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const identity = await requireIdentityForApi({ allowMissingAcceptances: true });
    const body = await readJsonBody(request);
    const { password, phrase } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const missing = [
      ...(typeof phrase === 'string' ? [] : [{ field: 'phrase', message: 'Type DELETE MY ACCOUNT exactly.' }]),
      ...(typeof password === 'string' ? [] : [{ field: 'password', message: 'The password is not right.' }]),
    ];
    if (missing.length > 0) throw new ValidationFailed(missing);
    await deleteAccount(identity.userId, { password: password as string, phrase: phrase as string });
    return new Response(null, { status: 204 });
  } catch (e) {
    return toResponse(e);
  }
}
