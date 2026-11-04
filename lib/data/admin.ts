import type { OrgRole } from '@prisma/client';
import type { AdminOrganisationRow, AgreementView, InvitationView } from '../../types/api';
import type { InvitationKind, InvitationState, UtcInstant } from '../../types/record';
import { identityLaneClient } from './identityClient';
import { invitationState } from './invitationState';
import { NotFoundError } from './tenant';

/**
 * The MAK-AI administrator's reads for S-23, S-24 and S-25 (FR-ORG-03, 05, 06, 07; 00-contract.md,
 * Typed stubs, `lib/data/admin.ts`). They run on the identity lane through `identityLaneClient`, whose
 * `makrai_identity` grants reach `organizations`, `memberships`, `invitations`, `organization_agreements`
 * and `users` and refuse every record table (ADR-0009), so nothing here can read a project, a decision or
 * a count of records. `__tests__/lint/admin-import-boundary.test.ts` holds the same line in the import
 * graph: no administrator module reaches a record module.
 *
 * Every write the administrator makes goes through the definer functions (`lib/data/definer.ts`); this
 * module only reads.
 */

const iso = (d: Date): UtcInstant => d.toISOString();

/** A `@db.Date` column as the calendar date it stores (`YYYY-MM-DD`); Prisma reads it as UTC midnight. */
const calendarDate = (d: Date): string => d.toISOString().slice(0, 10);

const newestFirst = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
const newestAgreementFirst = [{ recordedAt: 'desc' as const }, { id: 'desc' as const }];

/** S-23: every organisation, archived ones included and flagged, by name. */
export async function listOrganisationsForAdmin(): Promise<AdminOrganisationRow[]> {
  const now = new Date();
  const orgs = await identityLaneClient.organization.findMany({
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: {
      id: true, name: true, createdAt: true, deletedAt: true,
      _count: { select: { memberships: true } },
      agreements: { orderBy: newestAgreementFirst, take: 1, select: { agreementVersion: true } },
      invitations: { where: { kind: 'first_owner' }, orderBy: newestFirst, take: 1, select: { status: true, expiresAt: true } },
      memberships: { where: { role: 'owner', user: { isActive: true } }, take: 1, select: { id: true } },
    },
  });
  return orgs.map((o): AdminOrganisationRow => ({
    orgId: o.id,
    name: o.name,
    createdAt: iso(o.createdAt),
    currentAgreementVersion: o.agreements[0]?.agreementVersion ?? null,
    memberCount: o._count.memberships,
    ownerInvitationState: o.invitations[0] ? invitationState(o.invitations[0], now) : null,
    hasActiveOwner: o.memberships.length > 0,
    archived: o.deletedAt !== null,
  }));
}

/**
 * S-24's detail view: the organisation's row, its agreement records newest first (read-only; a newer
 * version is a new record, FR-ORG-05) and its first-owner invitations newest first. Name, creation date,
 * member count, agreements and invitation state only (W-10 note 2). `NotFoundError` for an unknown id.
 */
export async function organisationForAdmin(orgId: string): Promise<{
  row: AdminOrganisationRow; agreements: AgreementView[]; ownerInvitations: InvitationView[];
}> {
  // Prisma drops a `where` key whose value is undefined (lib/data/preauth.ts, lookupKey): refuse it first.
  if (typeof orgId !== 'string' || orgId.length === 0) throw new NotFoundError();
  const now = new Date();
  const o = await identityLaneClient.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true, name: true, createdAt: true, deletedAt: true,
      _count: { select: { memberships: true } },
      agreements: {
        orderBy: newestAgreementFirst,
        select: { id: true, agreementVersion: true, textHash: true, acceptedOn: true, controllerLegalName: true, dpContactEmail: true, recordedAt: true },
      },
      invitations: {
        where: { kind: 'first_owner' }, orderBy: newestFirst,
        select: { id: true, email: true, role: true, kind: true, status: true, expiresAt: true, createdAt: true, linkShownAt: true },
      },
      memberships: { where: { role: 'owner', user: { isActive: true } }, take: 1, select: { id: true } },
    },
  });
  if (!o) throw new NotFoundError();

  const fromShownLink = await accountsCreatedFromShownLink(o.invitations);
  const ownerInvitations = o.invitations.map((i): InvitationView => ({
    id: i.id, email: i.email, role: i.role as OrgRole, kind: i.kind as InvitationKind,
    state: invitationState({ status: i.status as InvitationState, expiresAt: i.expiresAt }, now),
    expiresAt: iso(i.expiresAt), createdAt: iso(i.createdAt), linkShown: i.linkShownAt !== null,
    createdFromShownLink: fromShownLink.has(i.id),
  }));
  const agreements = o.agreements.map((a): AgreementView => ({
    id: a.id, agreementVersion: a.agreementVersion, textHash: a.textHash, acceptedOn: calendarDate(a.acceptedOn),
    controllerLegalName: a.controllerLegalName, dpContactEmail: a.dpContactEmail, recordedAt: iso(a.recordedAt),
  }));
  return {
    row: {
      orgId: o.id, name: o.name, createdAt: iso(o.createdAt), currentAgreementVersion: agreements[0]?.agreementVersion ?? null,
      memberCount: o._count.memberships, ownerInvitationState: ownerInvitations[0]?.state ?? null,
      hasActiveOwner: o.memberships.length > 0, archived: o.deletedAt !== null,
    },
    agreements,
    ownerInvitations,
  };
}

/**
 * FR-ACC-10 on S-24 (gap G005): the accepted first-owner invitations whose link was shown and whose
 * accepting account was created at or after the link was shown, so the account came from the copied
 * link. The accepting account is the one with the invitation's email: acceptance refuses any other
 * (`accept_invitation`, contract Services, K0a).
 */
async function accountsCreatedFromShownLink(
  invitations: ReadonlyArray<{ id: string; email: string; status: string; linkShownAt: Date | null }>,
): Promise<Set<string>> {
  const shown = invitations.filter((i) => i.status === 'accepted' && i.linkShownAt !== null);
  if (shown.length === 0) return new Set();
  const users = await identityLaneClient.user.findMany({
    where: { OR: shown.map((i) => ({ email: { equals: i.email, mode: 'insensitive' as const } })) },
    select: { email: true, createdAt: true },
  });
  const createdAt = new Map(users.map((u) => [u.email.toLowerCase(), u.createdAt]));
  return new Set(shown.filter((i) => {
    const at = createdAt.get(i.email.toLowerCase());
    return at !== undefined && at.getTime() >= i.linkShownAt!.getTime();
  }).map((i) => i.id));
}

export interface AdminAccountRow {
  userId: string; name: string; email: string; platformRole: 'admin' | 'assessor'; isActive: boolean;
  createdAt: UtcInstant; onlyActiveOwnerOf: string[];
}

/**
 * S-25: every account, oldest first, with the names of the organisations whose only active owner it is
 * (FR-ORG-07: deactivating it needs the controller's request reference). The rule is the definer's own
 * (`admin_set_account_active`): an owner membership with no other owner whose account is active.
 */
export async function accountsForAdmin(): Promise<AdminAccountRow[]> {
  const [users, owners] = await Promise.all([
    identityLaneClient.user.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
    }),
    identityLaneClient.membership.findMany({
      where: { role: 'owner' },
      select: { userId: true, orgId: true, org: { select: { name: true } }, user: { select: { isActive: true } } },
    }),
  ]);
  const activeOwners = new Map<string, Set<string>>();
  for (const m of owners) {
    if (!m.user.isActive) continue;
    const set = activeOwners.get(m.orgId) ?? new Set<string>();
    set.add(m.userId);
    activeOwners.set(m.orgId, set);
  }
  const onlyOwnerOf = new Map<string, string[]>();
  for (const m of owners) {
    const set = activeOwners.get(m.orgId);
    if (!m.user.isActive || set?.size !== 1 || !set.has(m.userId)) continue;
    onlyOwnerOf.set(m.userId, [...(onlyOwnerOf.get(m.userId) ?? []), m.org.name]);
  }
  return users.map((u): AdminAccountRow => ({
    userId: u.id, name: u.name, email: u.email, platformRole: u.role, isActive: u.isActive, createdAt: iso(u.createdAt),
    onlyActiveOwnerOf: (onlyOwnerOf.get(u.id) ?? []).sort((a, b) => a.localeCompare(b)),
  }));
}
