import { randomBytes } from 'node:crypto';
import type { OrgRole } from '@prisma/client';
import { withOrg, assertCan, NotFoundError, type OrgContext, type TenantTx } from './tenant';
import { hashInvitationToken } from './invitationToken';
import { idempotentWrite, isRequestId } from './idempotency';
import { validateEmail } from '../validate';
import { ALL_ORG_ROLES } from '../authz/roles';
import { recordOrgEvent } from './orgEvents';
import { invitationState } from './invitationState';
import { ConflictError, RateLimitedError, ValidationFailed } from '../http/errors';
import { invitationAcceptUrl } from '../publicOrigin';
import { invitationEmail } from '../email/templates';
import { sendEmail } from '../email/send';
import { identityDb } from './identity';
import { logSecurityEvent } from '../security-logger';
import type { Actor, InvitationKind, InvitationState, WriteOutcome } from '../../types/record';
import type { FieldError } from '../../types/record';
import type { InvitationView, MemberView, InviteMemberRequest, InviteMemberResponse, ChangeRoleRequest, RequestIdBody, ResendInvitationRequest } from '../../types/api';

// ─── Request bodies (routes 25 to 29; every one carries a requestId, owner answer A1) ──────────────

function asObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationFailed([{ field: 'body', message: 'The request body must be a JSON object.' }]);
  }
  return raw as Record<string, unknown>;
}
const requestIdError = (o: Record<string, unknown>): FieldError[] =>
  isRequestId(o.requestId) ? [] : [{ field: 'requestId', message: 'requestId must be a UUID (8-4-4-4-12 hexadecimal).' }];
const roleError = (v: unknown): FieldError[] =>
  typeof v === 'string' && ALL_ORG_ROLES.includes(v as OrgRole) ? [] : [{ field: 'role', message: 'Choose a role.' }];
function showLinkOf(o: Record<string, unknown>, errors: FieldError[]): boolean {
  if (o.showLink === undefined) return false;
  if (typeof o.showLink === 'boolean') return o.showLink;
  errors.push({ field: 'showLink', message: 'showLink must be true or false.' });
  return false;
}

/** The body of route 25; the email is trimmed and lower-cased as it is stored. 422 names every field at fault. */
export function parseInviteRequest(raw: unknown): InviteMemberRequest {
  const o = asObject(raw);
  const errors: FieldError[] = [...requestIdError(o)];
  const emailError = validateEmail(o.email);
  if (emailError) errors.push({ field: 'email', message: emailError.message });
  errors.push(...roleError(o.role));
  const showLink = showLinkOf(o, errors);
  if (errors.length > 0) throw new ValidationFailed(errors);
  return { requestId: o.requestId as string, email: (o.email as string).trim().toLowerCase(), role: o.role as OrgRole, showLink };
}

/** The body of route 28. */
export function parseResendRequest(raw: unknown): { requestId: string; showLink: boolean } {
  const o = asObject(raw);
  const errors: FieldError[] = [...requestIdError(o)];
  const showLink = showLinkOf(o, errors);
  if (errors.length > 0) throw new ValidationFailed(errors);
  return { requestId: o.requestId as string, showLink };
}

/** The body of route 26 PATCH. */
export function parseChangeRoleRequest(raw: unknown): { requestId: string; role: OrgRole } {
  const o = asObject(raw);
  const errors = [...requestIdError(o), ...roleError(o.role)];
  if (errors.length > 0) throw new ValidationFailed(errors);
  return { requestId: o.requestId as string, role: o.role as OrgRole };
}

/** The body of routes 26 DELETE, 27 and 29: `{ requestId }` and nothing else is read. */
export function parseRequestIdBody(raw: unknown): { requestId: string } {
  const o = asObject(raw);
  const errors = requestIdError(o);
  if (errors.length > 0) throw new ValidationFailed(errors);
  return { requestId: o.requestId as string };
}

/** A value, not "expiring": an unspecified duration is one an implementer invents and nobody revisits. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** FR-MEM-01, SRS line 591. */
export const INVITES_PER_INVITER_PER_HOUR = 20;
export const INVITES_PER_ORG_PER_DAY = 100;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ROUTE_INVITE = 'app/api/v1/orgs/[slug]/members/route.ts::POST';

/** `rawToken` is set only on the first call; a receipt stores nothing of it and a replay answers null. */
export interface InvitationIssued { invitation: InvitationView; orgName: string; rawToken: string | null }

type InvitationRow = {
  id: string; email: string; role: OrgRole; kind: string; status: InvitationState; expiresAt: Date; createdAt: Date; linkShownAt: Date | null;
};

/** The wire shape of an invitation row (types/api.ts `InvitationView`); never carries the token hash. */
export function invitationView(r: InvitationRow, now: Date): InvitationView {
  return {
    id: r.id, email: r.email, role: r.role, kind: r.kind as InvitationKind,
    state: invitationState({ status: r.status, expiresAt: r.expiresAt }, now),
    expiresAt: r.expiresAt.toISOString(), createdAt: r.createdAt.toISOString(), linkShown: r.linkShownAt !== null,
  };
}

/**
 * The inserting transaction's guard against flooding (FR-MEM-01, obligation M4): one advisory lock per
 * organisation, then the two counts from the invitations table, so racing requests are counted one after the
 * other. Rows count whatever their status, a resend's replacement included. Throws before any insert.
 */
async function assertInviteRoom(tx: TenantTx, orgId: string, inviterId: string, now: Date): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'invitations:' + orgId}, 0))`;
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  /**
   * The moments that count against a limit; at the limit, refuses with the wait until the row whose leaving brings the
   * count back under it leaves the window (more rows than the limit can be there, so that row is not always the oldest).
   */
  const enforce = (times: Date[], windowMs: number, limit: 'per_inviter' | 'per_organisation', max: number) => {
    if (times.length < max) return;
    const freeing = [...times].sort((x, y) => x.getTime() - y.getTime())[times.length - max];
    logSecurityEvent('RATE_LIMIT_EXCEEDED', 'warn', { userId: inviterId, details: { orgId, limit } });
    throw new RateLimitedError(Math.max(1, (freeing.getTime() + windowMs - now.getTime()) / 1000));
  };
  const created = (where: { invitedById?: string; kind?: string; createdAt: { gt: Date } }) =>
    tx.invitation.findMany({ where, select: { createdAt: true } }).then((rows) => rows.map((r) => r.createdAt));
  // An inviter's attempts: the invitations they created and the refusals they were given for an address that is a member
  // (kept as receipts), so probing which addresses are members uses up the same 20 an hour.
  const refusals = (await tx.requestReceipt.findMany({
    where: { actorUserId: inviterId, route: ROUTE_INVITE, createdAt: { gt: hourAgo }, result: { path: ['refused'], equals: true } },
    select: { createdAt: true },
  })).map((r) => r.createdAt);
  enforce([...(await created({ invitedById: inviterId, createdAt: { gt: hourAgo } })), ...refusals], HOUR_MS, 'per_inviter', INVITES_PER_INVITER_PER_HOUR);
  // First-owner invitations are ORG's, issued by the administrator and bounded there: they do not use up the members' room.
  enforce(await created({ kind: 'member', createdAt: { gt: dayAgo } }), DAY_MS, 'per_organisation', INVITES_PER_ORG_PER_DAY);
}

/** Inserts a member invitation and its `member_invited` row; returns the row and the raw token (shown once). */
async function insertInvitation(
  tx: TenantTx, ctx: OrgContext, actor: Actor, a: { email: string; role: OrgRole; showLink: boolean }, now: Date,
): Promise<InvitationIssued> {
  const rawToken = randomBytes(32).toString('hex');
  const row = await tx.invitation.create({
    data: {
      orgId: ctx.orgId, email: a.email, role: a.role, tokenHash: hashInvitationToken(rawToken), invitedById: actor.userId,
      createdAt: now, expiresAt: new Date(now.getTime() + INVITATION_TTL_MS), kind: 'member', linkShownAt: a.showLink ? now : null,
    },
  });
  await recordOrgEvent(tx, { actorId: actor.userId, actorRole: actor.role, action: 'member_invited', targetInvitationId: row.id });
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } });
  return { invitation: invitationView(row, now), orgName: org.name, rawToken };
}

/** A replay's answer: the invitation re-read from the receipt's `rowId`; the token cannot be rebuilt from its hash. */
async function reissuedFromReceipt(tx: TenantTx, ctx: OrgContext, rowId: string | null, now: Date): Promise<InvitationIssued> {
  if (rowId === null) throw new TypeError('an invitation receipt carries the invitation id');
  const row = await tx.invitation.findUniqueOrThrow({ where: { id: rowId } });
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } });
  return { invitation: invitationView(row, now), orgName: org.name, rawToken: null };
}

/**
 * Invites a member (FR-MEM-01, route 25). The inviter's role caps the invitable role: only `owner` holds
 * `member:grant_owner`, and `member:invite` alone (admins hold it) does not prove it (obligation M1). The write is
 * the lock, the two counts, the insert and the event row, in one receipt-mode transaction (owner answer A1);
 * it sends nothing: the route sends E-01 through `deliverInvitation` after the commit.
 */
/** A refusal kept as a receipt, so it counts toward the inviter's hourly limit and a replay answers it again. */
type MemberRefused = { refused: 'already_member' };

export async function inviteMember(
  ctx: OrgContext, actor: Actor, body: InviteMemberRequest, digest: string, now: Date = new Date(),
): Promise<WriteOutcome<InvitationIssued>> {
  if (body.role === 'owner') assertCan(ctx, 'member:grant_owner');
  const outcome = await idempotentWrite<InvitationIssued | MemberRefused>(ctx, {
    table: 'request_receipts', route: ROUTE_INVITE, requestId: body.requestId, digest, actorUserId: actor.userId,
    write: async (tx) => {
      await assertInviteRoom(tx, ctx.orgId, actor.userId, now);
      // The 409 tells the inviter that this address belongs to a member, and S-22 lists names, not addresses. That is
      // accepted because every such refusal is kept as a receipt and counts toward the inviter's 20 an hour
      // (assertInviteRoom), which bounds how many addresses one person can test.
      const account = await identityDb.user.findUnique({ where: { email: body.email }, select: { id: true } });
      if (account !== null && (await tx.membership.findFirst({ where: { userId: account.id, status: 'active' }, select: { id: true } })) !== null) {
        return { refused: 'already_member' as const };
      }
      return insertInvitation(tx, ctx, actor, body, now);
    },
    receipt: (r) => ('refused' in r ? { rowId: null, result: { refused: true } } : { rowId: r.invitation.id }),
    replay: (tx, receipt) => (receipt.result?.refused === true ? Promise.resolve({ refused: 'already_member' as const }) : reissuedFromReceipt(tx, ctx, receipt.rowId, now)),
  });
  if ('refused' in outcome.value) {
    if (!outcome.replayed) {
      logSecurityEvent('ORG_MEMBER_ACTION', 'warn', { userId: actor.userId, details: { action: 'invite_refused_member', orgId: ctx.orgId, reason: outcome.value.refused } });
    }
    throw new ConflictError('already_member');
  }
  return { replayed: outcome.replayed, value: outcome.value };
}

/**
 * Sends E-01 after the transaction has committed and only when `replayed` was false. `acceptUrl` is non-null only
 * with `showLink`. A failed send is caught here, not left to propagate: the invitation and its receipt exist, and
 * a 500 would cost the inviter the copy-link they could still pass on. Logs ids and the provider's message id only.
 */
export async function deliverInvitation(a: {
  issued: InvitationIssued; showLink: boolean; orgId: string; actorUserId: string;
}): Promise<InviteMemberResponse> {
  const { invitation, orgName, rawToken } = a.issued;
  if (rawToken === null) throw new TypeError('deliverInvitation: a replay has no token and sends nothing');
  const acceptUrl = invitationAcceptUrl(rawToken);
  let emailSent = false;
  // Ids and a fixed reason only (NFR-OBS-01): the provider's own text can carry an address, so it is never logged.
  let failure: 'sender_unset' | 'api_key_unset' | 'send_failed' | null = null;
  const from = process.env.EMAIL_FROM_ADDRESS;
  if (typeof from !== 'string' || from.length === 0) failure = 'sender_unset';
  else if (!process.env.RESEND_API_KEY) failure = 'api_key_unset';
  else {
    try {
      const content = invitationEmail({ orgName, role: invitation.role, acceptUrl, expiresAt: new Date(invitation.expiresAt) });
      const sent = await sendEmail({ to: invitation.email, from, ...content });
      emailSent = true;
      logSecurityEvent('ORG_MEMBER_ACTION', 'info', {
        userId: a.actorUserId, details: { action: 'invite_email_sent', orgId: a.orgId, invitationId: invitation.id, resendMessageId: sent.id },
      });
    } catch {
      failure = 'send_failed';
    }
  }
  if (failure !== null) {
    logSecurityEvent('ORG_MEMBER_ACTION', 'error', {
      userId: a.actorUserId, details: { action: 'invite_email_failed', orgId: a.orgId, invitationId: invitation.id, reason: failure },
    });
  }
  return { invitation, acceptUrl: a.showLink ? acceptUrl : null, emailSent };
}

/**
 * The active members of the organisation, oldest first, with each one's name and whether the account was created
 * from a link its inviter had shown (FR-ACC-10, S-22). That is: the member's `member_joined` row names an
 * invitation, the invitation has `linkShownAt`, and the account is not older than the invitation. Names and account
 * dates come from the identity lane in one read; the tenant lane has no grant on `users`.
 */
export function listMembers(ctx: OrgContext): Promise<MemberView[]> {
  return withOrg(ctx, async (tx) => {
    const memberships = await tx.membership.findMany({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } });
    const joined = await tx.$queryRaw<{ targetUserId: string; targetInvitationId: string }[]>`
      SELECT "targetUserId", "targetInvitationId" FROM organisation_events
      WHERE action = 'member_joined' AND "targetInvitationId" IS NOT NULL AND "targetUserId" IS NOT NULL
      ORDER BY "at" ASC, id ASC`;   // the latest join decides, whichever row is read last
    const invitationIds = joined.map((j) => j.targetInvitationId);
    const invitations = invitationIds.length === 0 ? [] : await tx.invitation.findMany({
      where: { id: { in: invitationIds } }, select: { id: true, linkShownAt: true, createdAt: true },
    });
    const users = await identityDb.user.findMany({
      where: { id: { in: memberships.map((m) => m.userId) } }, select: { id: true, name: true, createdAt: true },
    });
    const userBy = new Map(users.map((u) => [u.id, u]));
    const invitationBy = new Map(invitations.map((i) => [i.id, i]));
    const invitationOf = new Map(joined.map((j) => [j.targetUserId, invitationBy.get(j.targetInvitationId)]));
    return memberships.map((m) => {
      const user = userBy.get(m.userId);
      const inv = invitationOf.get(m.userId);
      const fromShownLink = inv !== undefined && inv.linkShownAt !== null && user !== undefined && user.createdAt.getTime() >= inv.createdAt.getTime();
      return {
        userId: m.userId, name: user?.name ?? 'Unknown', role: m.role, joinedAt: m.createdAt.toISOString(), createdFromShownLink: fromShownLink,
      };
    });
  });
}

const ROUTE_RESEND = 'app/api/v1/orgs/[slug]/invitations/[invitationId]/resend/route.ts::POST';
const ROUTE_REVOKE = 'app/api/v1/orgs/[slug]/invitations/[invitationId]/revoke/route.ts::POST';

/** Pending member invitations, soonest-created first (FR-MEM-02). An expired one is not listed: it reads `expired`, not pending. */
export function listInvitations(ctx: OrgContext, now: Date): Promise<InvitationView[]> {
  return withOrg(ctx, async (tx) => {
    const rows = await tx.invitation.findMany({
      where: { kind: 'member', status: 'pending', expiresAt: { gt: now } }, orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => invitationView(r, now));
  });
}

/**
 * The member invitation `invitationId` of this organisation, for a resend or a revoke. Not found, another
 * organisation's (row-level security hides it) and a `first_owner` invitation (ORG's, FR-ORG-02) are the one
 * `NotFoundError`, answered 404 `not_found` (finding SEC-03). Revoking or resending an owner invitation needs
 * `member:grant_owner` (obligation M1), which an administrator of the organisation does not hold.
 */
async function memberInvitationOf(tx: TenantTx, ctx: OrgContext, invitationId: string) {
  const row = await tx.invitation.findUnique({ where: { id: invitationId } });
  if (row === null || row.kind !== 'member') throw new NotFoundError();
  if (row.role === 'owner') assertCan(ctx, 'member:grant_owner');
  return row;
}

/** Deletes the membership; a concurrent removal that got there first leaves no row, which is the coded 404, not a 500. */
async function deleteMembership(tx: TenantTx, id: string): Promise<void> {
  const { count } = await tx.membership.deleteMany({ where: { id } });
  if (count === 0) throw new NotFoundError();
}

/** The role gate that runs before the receipt is read: a caller who may no longer act gets 403 on a replay too. */
async function assertMayActOnInvitation(ctx: OrgContext, invitationId: string): Promise<void> {
  await withOrg(ctx, async (tx) => {
    const row = await tx.invitation.findUnique({ where: { id: invitationId }, select: { kind: true, role: true } });
    if (row !== null && row.kind === 'member' && row.role === 'owner') assertCan(ctx, 'member:grant_owner');
  });
}

/**
 * Resends an invitation (FR-MEM-02, route 28): a new row for the same address and role with a new token, the old
 * row moved to `revoked`, in one transaction, so the old link stops working at once (obligation M2). It counts
 * toward the same limits as an invitation (FR-MEM-01) and writes `member_invited` for the new row. Sends nothing.
 */
export async function resendInvitation(
  ctx: OrgContext, actor: Actor, a: ResendInvitationRequest & { invitationId: string }, digest: string, now: Date = new Date(),
): Promise<WriteOutcome<InvitationIssued>> {
  await assertMayActOnInvitation(ctx, a.invitationId);
  return idempotentWrite<InvitationIssued>(ctx, {
    table: 'request_receipts', route: ROUTE_RESEND, requestId: a.requestId, digest, actorUserId: actor.userId,
    write: async (tx) => {
      const old = await memberInvitationOf(tx, ctx, a.invitationId);
      if (invitationState({ status: old.status, expiresAt: old.expiresAt }, new Date()) !== 'pending') throw new ConflictError('invitation_not_pending');   // an expired one is not pending (FR-ORG-02's rule)
      await assertInviteRoom(tx, ctx.orgId, actor.userId, now);
      await revokePending(tx, old.id);
      return insertInvitation(tx, ctx, actor, { email: old.email, role: old.role, showLink: a.showLink }, now);
    },
    receipt: (r) => ({ rowId: r.invitation.id }),
    replay: (tx, receipt) => reissuedFromReceipt(tx, ctx, receipt.rowId, now),
  });
}

/**
 * Revokes a pending invitation (FR-MEM-02, route 29). Writes no organisation event: FR-ORG-09 lists "invited,
 * joined, role changed, removed, left" (owner default B9). A second revoke answers 409 `invitation_not_pending`;
 * a replay of the first finds its receipt before that check and answers as the first did.
 */
export async function revokeInvitation(
  ctx: OrgContext, actor: Actor, a: RequestIdBody & { invitationId: string }, digest: string,
): Promise<WriteOutcome<void>> {
  await assertMayActOnInvitation(ctx, a.invitationId);
  return idempotentWrite<void>(ctx, {
    table: 'request_receipts', route: ROUTE_REVOKE, requestId: a.requestId, digest, actorUserId: actor.userId,
    write: async (tx) => {
      const row = await memberInvitationOf(tx, ctx, a.invitationId);
      if (invitationState({ status: row.status, expiresAt: row.expiresAt }, new Date()) !== 'pending') throw new ConflictError('invitation_not_pending');
      await revokePending(tx, row.id);
    },
    receipt: () => ({ rowId: null }),
    replay: async () => undefined,
  });
}

const ROUTE_ROLE = 'app/api/v1/orgs/[slug]/members/[userId]/route.ts::PATCH';
const ROUTE_REMOVE = 'app/api/v1/orgs/[slug]/members/[userId]/route.ts::DELETE';
const ROUTE_LEAVE = 'app/api/v1/orgs/[slug]/members/leave/route.ts::POST';

/**
 * The active-owner guard (FR-MEM-04, obligation M5). Locks the organisation's owner memberships (ordered, so two
 * guards take the locks in one order and cannot deadlock), then counts the owners other than the one leaving or
 * being demoted whose account is active. A deactivated owner does not count. At zero: 409 `last_active_owner`.
 * The lock holds the members' own actions apart; the administrator's deactivation of an owner is not held off by
 * it (FR-ORG-07 allows it and S-23 flags the organisation, FR-ORG-02 recovers it).
 */
async function assertAnotherActiveOwner(tx: TenantTx, leavingUserId: string): Promise<void> {
  const owners = await tx.$queryRaw<{ userId: string }[]>`
    SELECT "userId" FROM memberships WHERE role = 'owner' AND status = 'active' ORDER BY id FOR UPDATE`;
  const others = owners.map((o) => o.userId).filter((id) => id !== leavingUserId);
  const active = others.length === 0 ? [] : await identityDb.user.findMany({ where: { id: { in: others }, isActive: true }, select: { id: true } });
  if (active.length === 0) throw new ConflictError('last_active_owner');
}

/**
 * Serialises the organisation's member writes (role change, removal, leave) before any of them reads its target,
 * so a read sees every earlier member write committed and the owner check in the write is made on the real role (M1).
 * Lock order in a member write is fixed: the request's receipt lock (idempotentWrite), then this one, then the owner
 * rows' FOR UPDATE (assertAnotherActiveOwner); the invitation limit uses its own key and no member write takes it.
 * No FOR UPDATE on the target row: it could deadlock against the owner-row lock.
 */
async function lockMemberWrites(tx: TenantTx, orgId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'members:' + orgId}, 0))`;
}

/** The active membership of `userId` in this organisation, or the one `NotFoundError` (404 `not_found`; SEC-03). */
async function activeMembershipOf(tx: TenantTx, userId: string) {
  const row = await tx.membership.findFirst({ where: { userId, status: 'active' }, select: { id: true, role: true } });
  if (row === null) throw new NotFoundError();
  return row;
}

/** Moves a pending invitation to revoked; one that a concurrent resend or revoke already moved is the coded 409, not the status trigger's error. */
async function revokePending(tx: TenantTx, id: string): Promise<void> {
  const { count } = await tx.invitation.updateMany({ where: { id, status: 'pending' }, data: { status: 'revoked' } });
  if (count === 0) throw new ConflictError('invitation_not_pending');
}

/** The role gate that runs before the receipt is read (a caller who may no longer act gets 403 on a replay): changing or removing an owner needs `member:revoke_owner`. */
async function assertMayChangeMember(ctx: OrgContext, userId: string): Promise<void> {
  await withOrg(ctx, async (tx) => {
    const row = await tx.membership.findFirst({ where: { userId, status: 'active' }, select: { role: true } });
    if (row !== null && row.role === 'owner') assertCan(ctx, 'member:revoke_owner');
  });
}

/**
 * Changes a member's role (FR-MEM-03, route 26 PATCH). The role is read from the row on every request
 * (lib/auth/context.ts:52-64), so it takes effect at the member's next action (obligation M8). An owner may set
 * any role; an administrator any role but owner, on a non-owner. Demoting an owner needs another active owner.
 * Writes one `member_role_changed` row with the earlier role, unless the role is the one already held.
 */
export async function changeMemberRole(
  ctx: OrgContext, actor: Actor, a: ChangeRoleRequest & { userId: string }, digest: string,
): Promise<WriteOutcome<void>> {
  if (a.role === 'owner') assertCan(ctx, 'member:grant_owner');
  await assertMayChangeMember(ctx, a.userId);
  return idempotentWrite<void>(ctx, {
    table: 'request_receipts', route: ROUTE_ROLE, requestId: a.requestId, digest, actorUserId: actor.userId,
    write: async (tx) => {
      await lockMemberWrites(tx, ctx.orgId);
      const target = await activeMembershipOf(tx, a.userId);
      if (target.role === 'owner') assertCan(ctx, 'member:revoke_owner');   // again, in the write: the pre-check's read may be stale (M1)
      if (target.role === 'owner' && a.role !== 'owner') await assertAnotherActiveOwner(tx, a.userId);
      if (target.role === a.role) return;
      await tx.membership.update({ where: { id: target.id }, data: { role: a.role } });
      await recordOrgEvent(tx, {
        actorId: actor.userId, actorRole: actor.role, action: 'member_role_changed', targetUserId: a.userId, previousValue: target.role,
      });
    },
    receipt: () => ({ rowId: null }),
    replay: async () => undefined,
  });
}

/** Removes a member (FR-MEM-04, route 26 DELETE): the membership row goes, one `member_removed` row stays. */
export async function removeMember(
  ctx: OrgContext, actor: Actor, a: RequestIdBody & { userId: string }, digest: string,
): Promise<WriteOutcome<void>> {
  await assertMayChangeMember(ctx, a.userId);
  return idempotentWrite<void>(ctx, {
    table: 'request_receipts', route: ROUTE_REMOVE, requestId: a.requestId, digest, actorUserId: actor.userId,
    write: async (tx) => {
      await lockMemberWrites(tx, ctx.orgId);
      const target = await activeMembershipOf(tx, a.userId);
      if (target.role === 'owner') {
        assertCan(ctx, 'member:revoke_owner');   // again, in the write: the pre-check's read may be stale (M1)
        await assertAnotherActiveOwner(tx, a.userId);
      }
      await deleteMembership(tx, target.id);
      await recordOrgEvent(tx, { actorId: actor.userId, actorRole: actor.role, action: 'member_removed', targetUserId: a.userId });
    },
    receipt: () => ({ rowId: null }),
    replay: async () => undefined,
  });
}

/** A member leaves (FR-MEM-05, route 27): as a removal of oneself, with the same guard; the `member_left` row names the leaver as actor and target. */
export function leaveOrganisation(
  ctx: OrgContext, actor: Actor, a: RequestIdBody, digest: string,
): Promise<WriteOutcome<void>> {
  return idempotentWrite<void>(ctx, {
    table: 'request_receipts', route: ROUTE_LEAVE, requestId: a.requestId, digest, actorUserId: actor.userId,
    write: async (tx) => {
      await lockMemberWrites(tx, ctx.orgId);
      const self = await activeMembershipOf(tx, actor.userId);
      if (self.role === 'owner') await assertAnotherActiveOwner(tx, actor.userId);
      await deleteMembership(tx, self.id);
      await recordOrgEvent(tx, { actorId: actor.userId, actorRole: actor.role, action: 'member_left', targetUserId: actor.userId });
    },
    receipt: () => ({ rowId: null }),
    replay: async () => undefined,
  });
}
