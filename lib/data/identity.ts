import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

/**
 * Non-tenant data only: User and ConsentRecord (17 of 50 call sites). Login
 * reads User before any organization is known, so withOrg structurally cannot
 * serve these.
 *
 * This client connects as `makrai`, the schema owner — a SUPERUSER with
 * BYPASSRLS. Superusers bypass RLS unconditionally and FORCE does not apply to
 * them, so a tenant query through this client would silently return every
 * organization's rows and no database control could stop it. The type below is
 * the enforcement point.
 *
 * It is an ALLOWLIST, not a denylist, and that is deliberate. `Omit<...>` of
 * the seven orgId-bearing models leaves three holes: $queryRaw* and
 * $executeRaw* survive it and reach any table; $transaction's handle is typed
 * with the FULL model set, so identityDb.$transaction(tx => tx.project...)
 * compiles; and any tenant model Plan 1b adds is admitted by default. Pick
 * closes all three, and fails CLOSED on models that do not exist yet — the
 * same reasoning ADR-0001 used to choose RLS over app-layer filtering.
 *
 * Adding a name here is a security decision. $transaction is withheld on
 * purpose: registration spans User and Membership, which straddles this
 * boundary, and Plan 1b must design that crossing rather than inherit it (D-061).
 */
type NonTenantClient = Pick<PrismaClient, 'user' | 'consentRecord'>;

const globalForIdentity = globalThis as unknown as { identityDb?: NonTenantClient };

function createIdentityClient(): NonTenantClient {
  return new PrismaClient({
    adapter: new PrismaPg(
      new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }),
    ),
  });
}

export const identityDb: NonTenantClient = globalForIdentity.identityDb ?? createIdentityClient();
if (process.env.NODE_ENV !== 'production') globalForIdentity.identityDb = identityDb;
