import { PrismaClient, type OrgRole } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { can, type Action } from '../authz/policy';

export type OrgContext = { orgId: string; role: OrgRole };

export class ForbiddenError extends Error {
  constructor(action: Action, role: OrgRole) {
    super(`role ${role} may not ${action}`);
    this.name = 'ForbiddenError';
  }
}

/** Authorization. Isolation is RLS's job — see ADR-0001. */
export function assertCan(ctx: OrgContext, action: Action): void {
  if (!can(ctx.role, action)) throw new ForbiddenError(action, ctx.role);
}

/**
 * Connects as makrai_app, which is NOBYPASSRLS — so a query that escapes the
 * org context returns nothing rather than another tenant's rows.
 */
const appClient = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: process.env.APP_DATABASE_URL })),
});

/**
 * The ONLY path to tenant data.
 *
 * Opens one interactive transaction, sets the org GUC that RLS policies read,
 * and hands the caller the transaction handle. It deliberately performs NO
 * filtering: RLS is the authoritative tenant filter (ADR-0001).
 *
 * set_config(..., true) is transaction-local AND parameterised. Never
 * interpolate an org id into a `SET LOCAL` string.
 */
export function withOrg<T>(
  ctx: OrgContext,
  cb: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return appClient.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${ctx.orgId}, true)`;
    return cb(tx);
  });
}
