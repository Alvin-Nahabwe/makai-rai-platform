import type { InvitationState } from '@/types/record';

/**
 * What an invitation reads as at `now`. A pending invitation is usable while
 * `expiresAt` is later than `now` (the sign-up lookups write `expiresAt: { gt: now }`,
 * lib/data/preauth.ts:128), so one whose `expiresAt` is `now` or earlier reads
 * `expired`; any other status is returned as stored.
 */
export function invitationState(
  inv: { status: InvitationState; expiresAt: Date },
  now: Date,
): InvitationState {
  if (inv.status === 'pending' && inv.expiresAt.getTime() <= now.getTime()) return 'expired';
  return inv.status;
}
