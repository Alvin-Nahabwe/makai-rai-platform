import type { OrgRole, Prisma } from '@prisma/client';
import type { ActorRole, OrgEventAction } from '../../types/record';
import type { OrgEventView } from '../../types/api';
import { AppError, ValidationFailed } from '../http/errors';
import { GONE_NAME_COPY } from '../http/copy';
import { lookupUserNames } from './identity';
import { withOrg, type OrgContext, type TenantTx } from './tenant';

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

/** The roles S-30 shows the rows to (FR-ORG-09, SRS line 577: "shall show owners and admins"). */
const MAY_READ_EVENTS: ReadonlySet<OrgRole> = new Set(['owner', 'admin']);
const MAX_PAGE = 100;
const GONE_ACCOUNT = GONE_NAME_COPY.deletedAccount;
const GONE_INVITATION = GONE_NAME_COPY.removedInvitation;

/**
 * FR-ORG-09 (S-30): the organisation's administrator and membership rows, newest first by `at`, then `id`,
 * at most `limit` (1 to 100) of them, after the event `before` names (the id of the last row already
 * shown). It runs on the tenant lane under `withOrg`, so row-level security limits it to the context's
 * organisation; a `before` that is not one of its events is refused, never read as "from the start". Only
 * owners and admins may read the rows, which can name invited emails. Names come from the identity lane
 * (`lookupUserNames`); an invitation target is named by its invited email.
 */
export async function listOrganisationEvents(
  ctx: OrgContext,
  page: { before?: string; limit: number },
): Promise<{ events: OrgEventView[]; hasMore: boolean }> {
  if (!MAY_READ_EVENTS.has(ctx.role)) throw new AppError(403, 'forbidden');
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > MAX_PAGE) {
    throw new ValidationFailed([{ field: 'limit', message: `Ask for 1 to ${MAX_PAGE} events.` }]);
  }
  const { rows, invitationEmails } = await withOrg(ctx, async (tx) => {
    let after: Prisma.OrganisationEventWhereInput = {};
    if (page.before !== undefined) {
      const anchor = typeof page.before === 'string' && page.before.length > 0
        ? await tx.organisationEvent.findUnique({ where: { id: page.before }, select: { id: true, at: true } })
        : null;
      if (!anchor) throw new ValidationFailed([{ field: 'before', message: 'This is not an event of this organisation.' }]);
      after = { OR: [{ at: { lt: anchor.at } }, { at: anchor.at, id: { lt: anchor.id } }] };
    }
    const found = await tx.organisationEvent.findMany({
      where: after, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: page.limit + 1,
    });
    const invitationIds = [...new Set(found.map((e) => e.targetInvitationId).filter((id): id is string => id !== null))];
    const invitations = invitationIds.length === 0 ? [] : await tx.invitation.findMany({
      where: { id: { in: invitationIds } }, select: { id: true, email: true },
    });
    return { rows: found, invitationEmails: new Map(invitations.map((i) => [i.id, i.email])) };
  });
  const shown = rows.slice(0, page.limit);
  const names = await lookupUserNames(shown.flatMap((e) => (e.targetUserId ? [e.actorId, e.targetUserId] : [e.actorId])));
  // A row's account or invitation can be gone although the application never deletes either: an operator, or a test's
  // cleanup, can. The row is still shown, with the reference named as gone, and one fixed line with the ids is logged
  // (NFR-OBS-01: ids only), so the gap is visible without taking the whole of S-30 down.
  const missing = (eventId: string, field: string, id: string): void => {
    console.warn(`org_event_reference_missing event=${eventId} field=${field} id=${id}`);
  };
  const nameOf = (eventId: string, field: 'actorId' | 'targetUserId', id: string): string => {
    const n = names.get(id);
    if (n) return n.name;
    missing(eventId, field, id);
    return GONE_ACCOUNT;
  };
  const emailOf = (eventId: string, id: string): string => {
    const email = invitationEmails.get(id);
    if (email !== undefined) return email;
    missing(eventId, 'targetInvitationId', id);
    return GONE_INVITATION;
  };
  const events = shown.map((e): OrgEventView => ({
    id: e.id,
    actorName: nameOf(e.id, 'actorId', e.actorId),
    actorRole: e.actorRole as ActorRole,
    action: e.action as OrgEventAction,
    targetName: e.targetUserId ? nameOf(e.id, 'targetUserId', e.targetUserId) : e.targetInvitationId ? emailOf(e.id, e.targetInvitationId) : null,
    reason: e.reason,
    requestReference: e.requestReference,
    previousValue: e.previousValue,
    at: e.at.toISOString(),
  }));
  return { events, hasMore: rows.length > page.limit };
}
