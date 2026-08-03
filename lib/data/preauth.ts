import {
  PrismaClient,
  type Membership,
  type Organization,
  type Invitation,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

/**
 * The before-context reads — and ONLY these.
 *
 * Some reads must happen before any org context exists: resolving which orgs a
 * user belongs to at login, mapping a URL slug to an organization, and looking
 * up an invitation by token. These are inherently cross-org ("which orgs am I
 * in" cannot be org-scoped), so no RLS policy can serve them; they run on the
 * owner connection, which bypasses RLS.
 *
 * That bypass is deliberate (ADR-0001) and must stay small. Do not add a
 * function here without deciding it is genuinely a before-context read —
 * __tests__/integration/preauth-surface.test.ts pins this module's exports and
 * will fail if the surface grows. The pin does not constrain what the existing
 * bodies return, so widening one (an added `include:`) is on the reviewer.
 */
const globalForPreauth = globalThis as unknown as { preauthClient?: PrismaClient };

function createOwnerClient() {
  return new PrismaClient({
    adapter: new PrismaPg(
      new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }),
    ),
  });
}

const ownerClient = globalForPreauth.preauthClient ?? createOwnerClient();
if (process.env.NODE_ENV !== 'production') globalForPreauth.preauthClient = ownerClient;

export function membershipsForUser(
  userId: string,
): Promise<(Membership & { org: Organization })[]> {
  return ownerClient.membership.findMany({
    where: { userId, status: 'active', org: { deletedAt: null } },
    include: { org: true },
  });
}

export function orgBySlug(slug: string): Promise<Organization | null> {
  return ownerClient.organization.findFirst({ where: { slug, deletedAt: null } });
}

/**
 * Fails closed: an expired or already-actioned invitation is indistinguishable
 * from a nonexistent one. The trade-off is deliberate — the caller cannot render
 * "your invitation expired" from this alone. Plan 1b adds a separate, explicitly
 * named lookup if that message is wanted, rather than every caller having to
 * remember the two checks.
 */
export function invitationByToken(token: string): Promise<Invitation | null> {
  return ownerClient.invitation.findFirst({
    where: { token, status: 'pending', expiresAt: { gt: new Date() } },
  });
}
