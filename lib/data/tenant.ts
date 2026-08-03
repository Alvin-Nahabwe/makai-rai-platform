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

/** Authorization only. Isolation is RLS's job (ADR-0001). Advisory: withOrg does
 *  not call this, so a caller that skips it gets full DML within its org. */
export function assertCan(ctx: OrgContext, action: Action): void {
  if (!can(ctx.role, action)) throw new ForbiddenError(action, ctx.role);
}

/**
 * Connects as makrai_app, which is NOBYPASSRLS — so an escaped query returns
 * nothing once Task 5's policies land.
 *
 * `max` is explicit: this process already runs a pool for lib/db.ts, and Plan 1b
 * adds identity and preauth pools. Four default pools would reserve 40 of the
 * server's 100 connections (max_connections verified live 2026-08-03).
 *
 * The globalThis guard mirrors lib/db.ts:5-17. Next.js dev HMR re-evaluates
 * modules, and without it every hot reload leaks a Pool until the server runs
 * out of connections. This closes D-060 rather than re-opening it.
 */
const globalForData = globalThis as unknown as { appClient?: PrismaClient };

function createAppClient() {
  return new PrismaClient({
    adapter: new PrismaPg(
      new Pool({ connectionString: process.env.APP_DATABASE_URL, max: 10 }),
    ),
  });
}

export const appClient = globalForData.appClient ?? createAppClient();
if (process.env.NODE_ENV !== 'production') globalForData.appClient = appClient;

/**
 * The ONLY path to tenant data.
 *
 * Opens one interactive transaction, sets the org GUC that RLS reads, and hands
 * the caller the transaction handle. It performs NO filtering — RLS is the
 * authoritative tenant filter. Forgetting to use it fails CLOSED: with no GUC
 * set the policy matches nothing and queries return zero rows.
 *
 * WHAT THIS DOES NOT DO: it does not check that the caller may use ctx.orgId.
 * RLS gives isolation, not authorization — hand it an org the user does not
 * belong to and it will scope faithfully to that org. Establishing that the
 * orgId is legitimately the caller's is requireOrgContext's job (Plan 1b), and
 * D-069 records the specific trap: users.lastActiveOrgId is unconstrained and
 * may name an org the user was removed from.
 *
 * set_config(..., true) is transaction-scoped AND parameterised. Never
 * interpolate an org id into a SET LOCAL string (SET LOCAL cannot be
 * parameterised at all), and never pass `false` — a session-scoped setting
 * would survive on a pooled connection into the next request.
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
