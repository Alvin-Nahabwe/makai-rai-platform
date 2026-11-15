import type { OrgRole } from '@prisma/client';
import type {
  AdminOrganisationRow, AgreementView, CorrectOrganisationRequest, CreateOrganisationRequest, InvitationView,
  IssueOwnerInvitationRequest,
} from '../../types/api';
import type { FieldError, InvitationKind, InvitationState, UtcInstant } from '../../types/record';
import { ValidationFailed } from '../http/errors';
import { HTTP_COPY, VALIDATION_COPY } from '../http/copy';
import { validateEmail } from '../validate';
import { identityLaneClient } from './identityClient';
import { invitationState } from './invitationState';
import { NotFoundError } from './tenant';
import { isRequestId } from './idempotency';
import { MAX_LEGAL_NAME, MAX_ORG_NAME, MAX_REQUEST_REFERENCE } from '../admin/limits';

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
      id: true, name: true, legalName: true, createdAt: true, deletedAt: true,
      _count: { select: { memberships: true } },
      invitations: { where: { kind: 'first_owner' }, orderBy: newestFirst, take: 1, select: { status: true, expiresAt: true } },
      memberships: { where: { role: 'owner', user: { isActive: true } }, take: 1, select: { id: true } },
    },
  });
  return orgs.map((o): AdminOrganisationRow => ({
    orgId: o.id,
    name: o.name,
    createdAt: iso(o.createdAt),
    legalName: o.legalName,
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
      id: true, name: true, legalName: true, createdAt: true, deletedAt: true,
      _count: { select: { memberships: true } },
      agreements: {
        orderBy: newestAgreementFirst,
        select: { id: true, agreementVersion: true, textHash: true, acceptedOn: true, controllerLegalName: true, dpContactEmail: true, recordedAt: true },
      },
      invitations: {
        where: { kind: 'first_owner' }, orderBy: newestFirst,
        select: { id: true, email: true, role: true, kind: true, status: true, expiresAt: true, createdAt: true, linkShownAt: true, acceptedAt: true },
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
      orgId: o.id, name: o.name, createdAt: iso(o.createdAt), legalName: o.legalName,
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
 * (`accept_invitation`, contract Services, K0a). An account with that address created after the
 * acceptance (the address freed by an account deletion and used again) did not accept it, so the
 * account must also be created at or before `acceptedAt`.
 */
async function accountsCreatedFromShownLink(
  invitations: ReadonlyArray<{ id: string; email: string; status: string; linkShownAt: Date | null; acceptedAt: Date | null }>,
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
    return at !== undefined && at.getTime() >= i.linkShownAt!.getTime() && (i.acceptedAt === null || at.getTime() <= i.acceptedAt.getTime());
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

/**
 * Whether the account holds any membership (route 47: the membership lock, NFR-SEC-04 (d), refuses the
 * platform role to a member, so the route names that reason instead of the single-administrator one).
 */
export async function accountHasMembership(userId: string): Promise<boolean> {
  // Prisma drops a `where` key whose value is undefined, which would count every membership on the platform.
  if (typeof userId !== 'string' || userId.length === 0) throw new TypeError('accountHasMembership: userId is required');
  return (await identityLaneClient.membership.count({ where: { userId } })) > 0;
}

// ── Routes 41 to 46: request bodies and the views they answer with ─────────────────────────────────────────────────

/** The longest organisation name (as the removed signed-in route, app/api/v1/orgs/route.ts:41) and request reference. */
export { MAX_ORG_NAME, MAX_REQUEST_REFERENCE };

const asObject = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

/** The plain names `VALIDATION_COPY.required` puts in "Enter the ...", one per field `textField` guards. */
const ORG_NAME_LABEL = "organisation's name";
const LEGAL_NAME_LABEL = "institution's legal name";
const REQUEST_REFERENCE_LABEL = 'request reference';

/** A required text of 1 to `max` characters after trimming, or a field error. */
function textField(o: Record<string, unknown>, key: string, field: string, label: string, max: number, errors: FieldError[]): string {
  const v = o[key];
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length === 0) errors.push({ field, message: VALIDATION_COPY.required(label) });
  else if (t.length > max) errors.push({ field, message: `Use ${max} characters or fewer.` });
  return t;
}

function emailField(o: Record<string, unknown>, key: string, field: string, errors: FieldError[]): string {
  const e = validateEmail(o[key]);
  if (e) {
    errors.push({ field, message: e.message });
    return '';
  }
  return (o[key] as string).trim().toLowerCase();
}

function showLinkField(o: Record<string, unknown>, errors: FieldError[]): boolean {
  if (typeof o.showLink !== 'boolean') errors.push({ field: 'showLink', message: 'Say whether to show the link.' });
  return o.showLink === true;
}

/** Route 41's body. An `agreement` key, which the removed form used to send, is ignored. */
export function parseCreateOrganisation(raw: unknown): CreateOrganisationRequest {
  const o = asObject(raw);
  const errors: FieldError[] = [];
  const name = textField(o, 'name', 'name', ORG_NAME_LABEL, MAX_ORG_NAME, errors);
  const legalName = textField(o, 'legalName', 'legalName', LEGAL_NAME_LABEL, MAX_LEGAL_NAME, errors);
  const ownerEmail = emailField(o, 'ownerEmail', 'ownerEmail', errors);
  const showLink = showLinkField(o, errors);
  // Retry-safe by request id (NFR-INT-02): the organisation's id is derived from it and the definer keeps a receipt.
  if (!isRequestId(o.requestId)) errors.push({ field: 'requestId', message: HTTP_COPY.outOfDate });
  if (errors.length > 0) throw new ValidationFailed(errors);
  return { requestId: o.requestId as string, name, legalName, ownerEmail, showLink };
}

/**
 * Route 42's body: exactly one of `name` and `legalName` (an allow-list of two keys; any other key is ignored, and
 * both or neither is refused).
 */
export function parseCorrectOrganisation(raw: unknown): CorrectOrganisationRequest {
  const o = asObject(raw);
  const hasName = Object.hasOwn(o, 'name');
  const hasLegalName = Object.hasOwn(o, 'legalName');
  if (hasName === hasLegalName) throw new ValidationFailed([{ field: 'name', message: 'Correct the name or the legal name, one at a time.' }]);
  const errors: FieldError[] = [];
  const request: CorrectOrganisationRequest = hasName
    ? { name: textField(o, 'name', 'name', ORG_NAME_LABEL, MAX_ORG_NAME, errors) }
    : { legalName: textField(o, 'legalName', 'legalName', LEGAL_NAME_LABEL, MAX_LEGAL_NAME, errors) };
  if (errors.length > 0) throw new ValidationFailed(errors);
  return request;
}

/** Route 44's body. */
export function parseIssueOwnerInvitation(raw: unknown): IssueOwnerInvitationRequest {
  const o = asObject(raw);
  const errors: FieldError[] = [];
  const email = emailField(o, 'email', 'email', errors);
  const requestReference = textField(o, 'requestReference', 'requestReference', REQUEST_REFERENCE_LABEL, MAX_REQUEST_REFERENCE, errors);
  const showLink = showLinkField(o, errors);
  if (errors.length > 0) throw new ValidationFailed(errors);
  return { email, requestReference, showLink };
}

/**
 * Routes 45 and 46: the first-owner invitation `invitationId` of organisation `orgId`, with what a resend needs before
 * it writes (the address and the organisation's name). A path id answers 404 for an unknown id, another
 * organisation's invitation and a member invitation alike (they are not the administrator's to resend or revoke), so
 * the answer tells nothing about which (AUTHZ ruling: path ids answer 404).
 */
export async function firstOwnerInvitationOf(orgId: string, invitationId: string): Promise<{ email: string; orgName: string }> {
  if (typeof orgId !== 'string' || orgId.length === 0 || typeof invitationId !== 'string' || invitationId.length === 0) throw new NotFoundError();
  const row = await identityLaneClient.invitation.findFirst({
    where: { id: invitationId, orgId, kind: 'first_owner' }, select: { email: true, org: { select: { name: true } } },
  });
  if (row === null) throw new NotFoundError();
  return { email: row.email, orgName: row.org.name };
}

/**
 * Whether an organisation is archived (FR-ORG-04): routes 44 and 45 refuse to invite a first owner into one, whose
 * every page would give the invitee S-31 (C4 ORG-SF-5). An unknown organisation is not found.
 */
export async function organisationArchivedForAdmin(orgId: string): Promise<boolean> {
  if (typeof orgId !== 'string' || orgId.length === 0) throw new NotFoundError();
  const org = await identityLaneClient.organization.findUnique({ where: { id: orgId }, select: { deletedAt: true } });
  if (org === null) throw new NotFoundError();
  return org.deletedAt !== null;
}

/** An organisation's slug, read on the identity lane: route 41's answer to a replay. */
export async function organisationSlugForAdmin(orgId: string): Promise<string> {
  const org = await identityLaneClient.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
  if (org === null) throw new NotFoundError();
  return org.slug;
}

/** Route 44: the organisation's name for E-01, read before anything is written; 404 for an unknown organisation. */
export async function organisationNameForAdmin(orgId: string): Promise<string> {
  if (typeof orgId !== 'string' || orgId.length === 0) throw new NotFoundError();
  const org = await identityLaneClient.organization.findUnique({ where: { id: orgId }, select: { name: true } });
  if (org === null) throw new NotFoundError();
  return org.name;
}

/** Route 42: the organisation's legal name (null when none is recorded), read before anything is written; 404 for an unknown organisation. */
export async function organisationLegalNameForAdmin(orgId: string): Promise<string | null> {
  if (typeof orgId !== 'string' || orgId.length === 0) throw new NotFoundError();
  const org = await identityLaneClient.organization.findUnique({ where: { id: orgId }, select: { legalName: true } });
  if (org === null) throw new NotFoundError();
  return org.legalName;
}

/**
 * A first-owner invitation of an organisation as S-24 shows it, read by id on the identity lane: route 45's answer to
 * a replay, which carries the invitation the first call made (never its link).
 */
export async function ownerInvitationViewOf(orgId: string, invitationId: string): Promise<InvitationView> {
  const i = await identityLaneClient.invitation.findFirst({ where: { id: invitationId, orgId, kind: 'first_owner' } });
  if (!i) throw new NotFoundError();
  return {
    id: i.id, email: i.email, role: i.role as OrgRole, kind: i.kind as InvitationKind,
    state: invitationState({ status: i.status as InvitationState, expiresAt: i.expiresAt }, new Date()),
    expiresAt: iso(i.expiresAt), createdAt: iso(i.createdAt), linkShown: i.linkShownAt !== null, createdFromShownLink: false,
  };
}

/**
 * The view of a first-owner invitation a definer function has just inserted, built from the values the route sent it
 * rather than read back, so nothing that can fail runs between the commit and the answer that carries the one-time
 * link. `createdAt` is the request's own time, taken just before the call; the row's own is the database's, a few
 * milliseconds later, and S-24 reads that one when it reloads.
 */
export function newOwnerInvitationView(a: { id: string; email: string; createdAt: Date; expiresAt: Date; linkShown: boolean }): InvitationView {
  return {
    id: a.id, email: a.email, role: 'owner', kind: 'first_owner', state: 'pending',
    expiresAt: iso(a.expiresAt), createdAt: iso(a.createdAt), linkShown: a.linkShown, createdFromShownLink: false,
  };
}
