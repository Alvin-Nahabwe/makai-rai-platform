import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

/**
 * Non-tenant data only: User and ConsentRecord.
 *
 * These have no orgId and no org context — login reads User before any
 * organization is known. 17 of 50 call sites are in this category, which is
 * why a single universal wrapper cannot serve the app (ADR-0001).
 *
 * Do NOT reach tenant models through this client. Use withOrg().
 *
 * This is not merely a convention. `identityDb` connects via DATABASE_URL as
 * `makrai`, the schema-owner role — a Postgres SUPERUSER with BYPASSRLS
 * (verified live: `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE
 * rolname='makrai'` returns `t|t`). Superusers bypass row-level security
 * unconditionally; `FORCE ROW LEVEL SECURITY` (Task 5) does not apply to
 * them. A tenant query issued through this client would silently return
 * every organization's rows, and no database-level control can prevent
 * that — Task 5's policies cannot close this gap, because the database
 * will never constrain a superuser. The type below is the enforcement
 * point: it removes every orgId-bearing model from the exported client's
 * type so a call site attempting `identityDb.project` (etc.) fails to
 * compile, rather than compiling and silently reading cross-tenant data.
 *
 * Excludes every model that carries `orgId` in prisma/schema.prisma:
 * Project, ProjectMetadata, Assessment, RemediationItem (Task 4's tenant
 * data), plus Organization, Membership, Invitation (tenant data introduced
 * in Task 2, reached only via withOrg once Plan 1b's requireOrgContext
 * exists — never through this client, even though membership lookup
 * during login is a similar "before OrgContext exists" situation to User).
 */
type NonTenantClient = Omit<
  PrismaClient,
  | 'project'
  | 'projectMetadata'
  | 'assessment'
  | 'remediationItem'
  | 'organization'
  | 'membership'
  | 'invitation'
>;

export const identityDb: NonTenantClient = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL })),
});
