import { createHash } from 'node:crypto';

/**
 * The ONE place the invitation token hashing scheme is written. Mint
 * (`createInvitation`, lib/data/members.ts) and both verify sites
 * (`invitationByToken` and `acceptInvitation`, lib/data/preauth.ts) all call
 * this instead of each carrying its own `createHash('sha256')...` literal —
 * a `simplify` pass on Task 8 found the scheme duplicated three times,
 * coupled only by a comment warning "the two must never diverge, or every
 * invitation becomes silently unacceptable." A shared function makes that
 * structurally true instead of a convention someone has to remember during
 * a future edit.
 *
 * sha256 hex digest, matching `invitations.tokenHash`'s
 * `invitations_tokenHash_is_sha256_hex` CHECK constraint (D-097).
 */
export function hashInvitationToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
