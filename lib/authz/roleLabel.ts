import type { Identity } from '@/lib/auth/identity';
import { membershipsForUser } from '@/lib/data/preauth';

/**
 * The role a person is shown in the sidebar (UX-02, SRS lines 1523-1524): "owner" to "viewer", their role in the
 * organisation named by the slug of the open page; "MAK-AI administrator" for the platform role; or null on a
 * page of no organisation, or of one the account is not an active member of (an unknown slug, a suspended
 * membership, an archived organisation). Never `User.role`, the platform role field, which defaults to
 * `assessor` for every ordinary account.
 *
 * Read fresh on every call (`membershipsForUser`, lib/data/preauth.ts, filters active memberships of
 * organisations not deleted), so a role change shows on the member's next page, as the gate that decides the
 * request reads it (FR-MEM-03). A label only: authorisation is `requireOrgContextFor` (lib/auth/context.ts).
 * A platform administrator holds no membership (NFR-SEC-04 (d)), so the platform role is the only label it has.
 */
export async function orgRoleLabel(identity: Identity, orgSlug: string | undefined): Promise<string | null> {
  if (identity.platformRole === 'admin') return 'MAK-AI administrator';
  if (orgSlug === undefined) return null;
  const membership = (await membershipsForUser(identity.userId)).find((m) => m.org.slug === orgSlug);
  return membership ? membership.role : null;
}
