import type { OrgRole, Prisma } from '@prisma/client';
import { AppError } from '../http/errors';
import type { AgreementInput } from '../../types/api';
import { identityLaneClient } from './identityClient';

/**
 * Typed wrappers for the eight SECURITY DEFINER functions of migration
 * 20261030000500_v060_05_functions (00-contract.md, Services, K0a; SRS 9.5 line 3673). Every
 * administrator action and every invitation acceptance writes only through these: the function
 * checks its actor, writes the action and its FR-ORG-09 row in one transaction, and runs as the
 * NOLOGIN role makrai_definer. The identity lane executes them; nothing here writes a table.
 *
 * A function refuses with SQLSTATE P0001 and the message `makrai:<code>`; `callDefiner` maps the
 * codes of `DEFINER_ERRORS` to `AppError(status, code)` and rethrows every other error unchanged,
 * so a bad argument or a broken invariant is never reported as an expected refusal.
 *
 * Where a function acts on an existing row (an invitation, an account's memberships) its
 * organisation is read here on the identity lane, whose identity_lane policies show every
 * invitation and membership, and passed to the function, which re-reads its target under that
 * organisation's context: a wrong id gives "not found" there, never another organisation's row.
 */

type Tx = Prisma.TransactionClient;

/** Each `makrai:<code>` a definer function raises, with its HTTP status (contract, Error codes). */
const DEFINER_ERRORS: Readonly<Record<string, number>> = Object.freeze({
  not_platform_admin: 403,
  not_found: 404,
  slug_taken: 409,
  active_owner_exists: 409,
  pending_owner_invitation_exists: 409,
  invitation_not_pending: 409,
  self_deactivation: 409,
  invitation_unusable: 410,
  request_reference_required: 422,
});

/** The `makrai:<code>` of a definer refusal, or null for any other error. */
function definerErrorCode(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null;
  const meta = (e as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return null;
  const adapterError = (meta as { driverAdapterError?: unknown }).driverAdapterError;
  if (typeof adapterError !== 'object' || adapterError === null) return null;
  const cause = (adapterError as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return null;
  const { originalCode, originalMessage } = cause as { originalCode?: unknown; originalMessage?: unknown };
  if (originalCode !== 'P0001' || typeof originalMessage !== 'string') return null;
  const m = /^makrai:([a-z_]+)$/.exec(originalMessage);
  return m && Object.hasOwn(DEFINER_ERRORS, m[1]) ? m[1] : null;
}

async function callDefiner<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const code = definerErrorCode(e);
    if (code === null) throw e;
    throw new AppError(DEFINER_ERRORS[code], code);
  }
}

/** FR-ORG-01: organisation, agreement record and first-owner invitation, in one transaction. */
export async function adminCreateOrganisation(a: {
  actorUserId: string; name: string; slug: string; agreement: AgreementInput; ownerEmail: string;
  tokenHash: string; expiresAt: Date; linkShown: boolean;
}): Promise<{ orgId: string; invitationId: string }> {
  const [row] = await callDefiner(() => identityLaneClient.$queryRaw<{ org_id: string; invitation_id: string }[]>`
    SELECT org_id, invitation_id FROM admin_create_organisation(${a.actorUserId}::text, ${a.name}::text, ${a.slug}::text,
      ${a.agreement.agreementVersion}::text, ${a.agreement.textHash}::text, ${a.agreement.acceptedOn}::date,
      ${a.agreement.controllerLegalName}::text, ${a.agreement.dpContactEmail}::text, ${a.ownerEmail}::text,
      ${a.tokenHash}::text, ${a.expiresAt}::timestamptz, ${a.linkShown}::boolean)`);
  return { orgId: row.org_id, invitationId: row.invitation_id };
}

/** FR-ORG-05, 06, 10: a newer agreement record for an organisation. */
export async function adminRecordAgreement(a: {
  actorUserId: string; orgId: string; agreement: AgreementInput;
}): Promise<{ agreementId: string }> {
  const [row] = await callDefiner(() => identityLaneClient.$queryRaw<{ id: string }[]>`
    SELECT admin_record_agreement(${a.actorUserId}::text, ${a.orgId}::text, ${a.agreement.agreementVersion}::text,
      ${a.agreement.textHash}::text, ${a.agreement.acceptedOn}::date, ${a.agreement.controllerLegalName}::text,
      ${a.agreement.dpContactEmail}::text) AS id`);
  return { agreementId: row.id };
}

/** FR-ORG-02: a new first-owner invitation while the organisation has no active owner and none pending. */
export async function adminIssueOwnerInvitation(a: {
  actorUserId: string; orgId: string; email: string; tokenHash: string; expiresAt: Date;
  requestReference: string; linkShown: boolean;
}): Promise<{ invitationId: string }> {
  const [row] = await callDefiner(() => identityLaneClient.$queryRaw<{ id: string }[]>`
    SELECT admin_issue_owner_invitation(${a.actorUserId}::text, ${a.orgId}::text, ${a.email}::text, ${a.tokenHash}::text,
      ${a.expiresAt}::timestamptz, ${a.requestReference}::text, ${a.linkShown}::boolean) AS id`);
  return { invitationId: row.id };
}

/** The organisation of an invitation, read on the identity lane; '' when there is none. */
async function invitationOrg(client: Tx | typeof identityLaneClient, where: { id: string } | { tokenHash: string }): Promise<string> {
  const row = await client.invitation.findUnique({ where, select: { orgId: true } });
  return row?.orgId ?? '';
}

/** FR-ORG-02: resend a pending first-owner invitation (a new row; the old one is revoked). */
export async function adminResendInvitation(a: {
  actorUserId: string; invitationId: string; tokenHash: string; expiresAt: Date; linkShown: boolean;
}): Promise<{ invitationId: string }> {
  const orgId = await invitationOrg(identityLaneClient, { id: a.invitationId });
  const [row] = await callDefiner(() => identityLaneClient.$queryRaw<{ id: string }[]>`
    SELECT admin_resend_invitation(${a.actorUserId}::text, ${orgId}::text, ${a.invitationId}::text, ${a.tokenHash}::text,
      ${a.expiresAt}::timestamptz, ${a.linkShown}::boolean) AS id`);
  return { invitationId: row.id };
}

/** FR-ORG-02: revoke a pending first-owner invitation. */
export async function adminRevokeInvitation(a: { actorUserId: string; invitationId: string }): Promise<void> {
  const orgId = await invitationOrg(identityLaneClient, { id: a.invitationId });
  await callDefiner(() => identityLaneClient.$executeRaw`
    SELECT admin_revoke_invitation(${a.actorUserId}::text, ${orgId}::text, ${a.invitationId}::text)`);
}

/**
 * FR-ORG-07, FR-ACC-06, FR-ORG-09: deactivate or reactivate an account. One identity-lane
 * transaction locks the account's row first, so a membership being created for it (whose lock
 * trigger takes the same row FOR SHARE) waits until this commits, then reads the account's
 * organisations and hands them to the function: every organisation the account belongs to gets
 * its row.
 */
export async function adminSetAccountActive(a: {
  actorUserId: string; userId: string; active: boolean; requestReference: string | null;
}): Promise<{ affectedOrgIds: string[] }> {
  return callDefiner(() => identityLaneClient.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${a.userId}::text FOR UPDATE`;
    const memberships = await tx.membership.findMany({ where: { userId: a.userId }, select: { orgId: true } });
    const orgIds = memberships.map((m) => m.orgId);
    const [row] = await tx.$queryRaw<{ affected: string[] }[]>`
      SELECT admin_set_account_active(${a.actorUserId}::text, ${a.userId}::text, ${a.active}::boolean,
        ${a.requestReference}::text, ${orgIds}::text[]) AS affected`;
    return { affectedOrgIds: row.affected };
  }));
}

/** One platform-lane row of a person's export: ids, kinds, times and the person's roles only. */
export type PersonalPlatformRow = {
  source: 'platform_event' | 'organisation_agreement' | 'organisation_event';
  id: string; orgId: string | null; organisation: string | null; kind: string; at: Date;
  roles: Array<'acted' | 'named' | 'entered'>;
};

/**
 * FR-EXP-02, NFR-PRIV-08: the rows that name `userId` and that no membership shows them, in every organisation (a
 * platform administrator holds no membership):
 * - through `personal_platform_rows` (migration 20261105000000), which no application lane can otherwise read:
 *   their platform_events (as actor or target) and the organisation events they acted in as platform_admin. The
 *   organisations are read here on the identity lane and handed to the function, which sets each one's context (as
 *   adminSetAccountActive's wrapper does). The function trusts the id it is given (ADR-0009, Definer functions), so
 *   this has one caller, personalExport for route 38's signed-in session
 *   (__tests__/lint/personal-platform-rows-caller.test.ts).
 * - directly on the identity lane, whose identity_lane policy shows every agreement (makrai_definer stays INSERT-only
 *   on them, C4 EXP re-review N-1): the organization_agreements they recorded (`entered`), matched by account id
 *   only. An agreement's dpContactEmail is never matched against the account's address: an address is not proof
 *   that the account is that contact, so matching it would hand one organisation's agreement to whoever holds the
 *   address (controller ruling on M-3; the operator answers a DP contact on request). No other column leaves here.
 */
export async function personalPlatformRows(userId: string): Promise<PersonalPlatformRow[]> {
  return identityLaneClient.$transaction(async (tx) => {
    const orgIds = (await tx.organization.findMany({ select: { id: true } })).map((o) => o.id);
    const platform = await tx.$queryRaw<Array<Omit<PersonalPlatformRow, 'roles'> & { role: 'acted' | 'named' }>>`
      SELECT "source", "id", "orgId", "organisation", "kind", "at", "role"
      FROM personal_platform_rows(${userId}::text, ${orgIds}::text[])`;
    const agreements = await tx.$queryRaw<Array<{ id: string; orgId: string; organisation: string; kind: string; at: Date }>>`
      SELECT a."id", a."orgId", g."name" AS "organisation", a."agreementVersion" AS "kind", a."recordedAt" AS "at"
      FROM organization_agreements a JOIN organizations g ON g."id" = a."orgId"
      WHERE a."recordedById" = ${userId}::text`;
    const rows: PersonalPlatformRow[] = [
      ...platform.map(({ role, ...r }) => ({ ...r, roles: [role] })),
      ...agreements.map((a) => ({
        source: 'organisation_agreement' as const, id: a.id, orgId: a.orgId, organisation: a.organisation, kind: a.kind, at: a.at,
        roles: ['entered' as const],
      })),
    ];
    return rows.sort((x, y) => x.at.getTime() - y.at.getTime() || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  });
}

/** FR-ORG-10: correct an organisation's name; the earlier name is kept in the change's row. */
export async function adminCorrectOrgName(a: {
  actorUserId: string; orgId: string; name: string;
}): Promise<{ previousName: string }> {
  const [row] = await callDefiner(() => identityLaneClient.$queryRaw<{ previous: string }[]>`
    SELECT admin_correct_org_name(${a.actorUserId}::text, ${a.orgId}::text, ${a.name}::text) AS previous`);
  return { previousName: row.previous };
}

/**
 * FR-ACC-01, FR-ORG-09: the membership and its member_joined row. With `tx` (an identity-lane
 * interactive transaction of lib/data/preauth.ts's client) both the read and the call run on
 * it, so the new account, its acceptance rows and the membership commit or roll back together
 * (FR-ACC-03, gap G026). Every refusal is `invitation_unusable` (M-23).
 */
export async function acceptInvitationViaDefiner(
  a: { tokenHash: string; userId: string },
  tx?: Prisma.TransactionClient,
): Promise<{ orgId: string; role: OrgRole }> {
  const client = tx ?? identityLaneClient;
  const orgId = await invitationOrg(client, { tokenHash: a.tokenHash });
  const [row] = await callDefiner(() => client.$queryRaw<{ accepted_org_id: string; accepted_role: OrgRole }[]>`
    SELECT accepted_org_id, accepted_role::text AS accepted_role
    FROM accept_invitation(${orgId}::text, ${a.tokenHash}::text, ${a.userId}::text)`);
  return { orgId: row.accepted_org_id, role: row.accepted_role };
}
