/* eslint-disable @typescript-eslint/no-unused-vars -- the stub keeps the contract's parameter names; AUTHZ replaces the body. */
import type { Identity } from '@/lib/auth/identity';

/**
 * The role a person is shown in the sidebar (UX-02): "owner" to "viewer" in the organisation named by the
 * slug, "MAK-AI administrator" for the platform role, or null. A typed stub until AUTHZ merges; UI's sidebar
 * calls it.
 */
// CONTRACT_STUB: AUTHZ
export async function orgRoleLabel(identity: Identity, orgSlug: string | undefined): Promise<string | null> {
  return null;
}
