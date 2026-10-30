import type { ActorRole, OrgEventAction } from '../../types/record';
import type { OrgEventView } from '../../types/api';
import type { OrgContext, TenantTx } from './tenant';

/** The membership changes whose row names the member concerned (contract, Data model, `Membership`). */
const NEEDS_TARGET: ReadonlySet<OrgEventAction> = new Set(['member_role_changed', 'member_removed', 'member_left']);

/**
 * FR-ORG-09: one organisation_events row, in the caller's transaction, for a membership change
 * on the app lane (MEM; EXP's account deletion as `member_left`). One raw INSERT that omits
 * `orgId`: the column default takes the transaction's organisation (finding F14), and
 * org_isolation still checks it. The insert trigger refuses administrator and join rows on the
 * app lane, and a member row without its target; the TypeError here names that mistake before
 * any SQL.
 */
export async function recordOrgEvent(tx: TenantTx, row: {
  actorId: string; actorRole: ActorRole; action: OrgEventAction; targetUserId?: string | null;
  targetInvitationId?: string | null; reason?: string | null; requestReference?: string | null; previousValue?: string | null;
}): Promise<void> {
  if (NEEDS_TARGET.has(row.action) && !row.targetUserId) {
    throw new TypeError(`recordOrgEvent: ${row.action} needs targetUserId, the member concerned`);
  }
  await tx.$executeRaw`
    INSERT INTO "organisation_events" ("id", "actorId", "actorRole", "action", "targetUserId", "targetInvitationId",
      "reason", "requestReference", "previousValue")
    VALUES (gen_random_uuid()::text, ${row.actorId}, ${row.actorRole}, ${row.action}, ${row.targetUserId ?? null},
      ${row.targetInvitationId ?? null}, ${row.reason ?? null}, ${row.requestReference ?? null}, ${row.previousValue ?? null})`;
}

// CONTRACT_STUB: ORG
export async function listOrganisationEvents(
  _ctx: OrgContext,
  _page: { before?: string; limit: number },
): Promise<{ events: OrgEventView[]; hasMore: boolean }> {
  return { events: [], hasMore: false };
}
