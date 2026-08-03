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
 * closes those three, and fails CLOSED on models that do not exist yet.
 *
 * `Pick` DOES NOT close a fourth hole, and an earlier version of this comment
 * wrongly implied it did. Handing over the `user` delegate hands over the whole
 * of it, including `include`/`select` and nested writes — and `User` has
 * relations to five tenant models. Found by the C6 whole-branch security review
 * and reproduced live 2026-08-03: `identityDb.user.findMany({ include: {
 * memberships: { include: { org: true } }, projects: true, sentInvitations:
 * true } })` type-checks, passes lint, passes every RLS test — and returns
 * other organizations' projects, the full membership graph, and live invitation
 * tokens. The write form is worse: a nested `memberships.updateMany` performs an
 * unauthorized cross-tenant role change with RLS fully bypassed and `can()`
 * never consulted.
 *
 * So the type is NOT sufficient on its own, and correct-looking prose over an
 * incomplete control is more dangerous than no prose — a reviewer trusts it. The
 * runtime guard below is the actual enforcement point; the type is the ergonomic
 * half that makes the common mistake visible in the editor.
 *
 * Adding a name here is a security decision. $transaction is withheld on
 * purpose: registration spans User and Membership, which straddles this
 * boundary, and Plan 1b must design that crossing rather than inherit it (D-061).
 */

/**
 * Relations from `User`/`ConsentRecord` that reach orgId-bearing tables.
 * Kept as a literal list rather than derived, so adding a tenant relation to
 * `User` in Plan 1b does not silently widen the bypass — the guard test names
 * these, and a new relation absent from this set is a review failure.
 */
const TENANT_RELATIONS = new Set([
  'projects',
  'assessments',
  'completedRemediations',
  'memberships',
  'sentInvitations',
  'org',
  'organization',
]);

function assertNoTenantRelation(args: unknown): void {
  if (args === null || typeof args !== 'object') return;
  const a = args as Record<string, unknown>;
  for (const clause of ['include', 'select', 'data', 'where', 'orderBy'] as const) {
    const bag = a[clause];
    if (bag === null || typeof bag !== 'object') continue;
    for (const name of Object.keys(bag)) {
      if (TENANT_RELATIONS.has(name)) {
        throw new Error(
          `identityDb: '${name}' is tenant data and this client bypasses RLS ` +
            `(it connects as the schema owner). Route it through withOrg instead — see ADR-0001.`,
        );
      }
    }
  }
}

type NonTenantClient = Pick<PrismaClient, 'user' | 'consentRecord'>;

const globalForIdentity = globalThis as unknown as { identityDb?: NonTenantClient };

function createIdentityClient(): NonTenantClient {
  const base = new PrismaClient({
    adapter: new PrismaPg(
      new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }),
    ),
  });

  // $extends is used here purely to inspect arguments — it never touches
  // connection state, so the Task-0 spike's NO-GO (which was specifically about
  // set_config and the query landing on different pooled connections) does not
  // apply. The callback delegates to query(args) unchanged.
  return base.$extends({
    query: {
      user: {
        $allOperations({ args, query }) {
          assertNoTenantRelation(args);
          return query(args);
        },
      },
      consentRecord: {
        $allOperations({ args, query }) {
          assertNoTenantRelation(args);
          return query(args);
        },
      },
    },
  }) as unknown as NonTenantClient;
}

export const identityDb: NonTenantClient = globalForIdentity.identityDb ?? createIdentityClient();
if (process.env.NODE_ENV !== 'production') globalForIdentity.identityDb = identityDb;
