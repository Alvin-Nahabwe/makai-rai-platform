import { PrismaClient, type OrgRole, type Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { can, type Action } from '../authz/policy';
import { hmrSingleton, requireDatabaseUrl } from './connection';

export type OrgContext = { orgId: string; role: OrgRole };

/**
 * The transaction handle handed to a withOrg callback.
 *
 * This is `Prisma.TransactionClient`, the generated name for exactly this type.
 * It replaces a hand-rolled `Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]`,
 * which resolved correctly only by accident: `Parameters<>` on an overloaded
 * signature picks the LAST overload, and `$transaction`'s interactive form
 * merely happens to be last. Reordering the overloads in a future generator
 * release would silently have re-pointed it at the array form.
 *
 * KNOW WHAT THIS DOES NOT EXCLUDE. Prisma 7's `ITXClientDenyList` is
 * `["$connect","$disconnect","$on","$use","$extends"]` — lifecycle methods only
 * (`@prisma/client/runtime/client.d.ts`). `$executeRaw` and `$queryRaw` remain
 * reachable, so a callback can run
 * `tx.$executeRaw`SELECT set_config('app.current_org_id', <any org>, true)`` and
 * re-scope itself for the rest of the transaction. RLS cannot stop that: setting
 * a GUC is unprivileged, which is the same limit D-077 records. That is a
 * first-party footgun rather than an attacker path — the callback is our own
 * code — so narrowing it is deferred to Plan 1b under D-088 rather than done
 * here, because the tenant-layer tests legitimately use `tx.$queryRaw` to assert
 * the GUC and would need a separate handle.
 */
export type TenantTx = Prisma.TransactionClient;

export class ForbiddenError extends Error {
  constructor(
    readonly action: Action,
    readonly role: OrgRole,
  ) {
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
 * `hmrSingleton` guards against Next.js dev hot-reload re-evaluating this module
 * and leaking a Pool per reload until the server runs out of connections — the
 * D-060 gap. It lives in ./connection.ts because the pattern was hand-rolled at
 * four sites and omitted at two of them; a named helper makes the omission
 * visible at the call site.
 */

function createAppClient() {
  return new PrismaClient({
    adapter: new PrismaPg(
      new Pool({ connectionString: requireDatabaseUrl('APP_DATABASE_URL'), max: 10, options: '' }),
    ),
  });
}

/**
 * Asserts, once per process and on the live connection, that we are NOT
 * connected as a superuser or a BYPASSRLS role.
 *
 * A presence check on the URL is not sufficient. The URL can be present and
 * still point at the owner — a copy-paste from `.env.example`, a shared
 * `DATABASE_URL` reused for both, a staging config that never got its own role.
 * In that case every control on this branch still "works": the GUC is set, the
 * policies exist, the tests pass — and RLS is bypassed for every query, because
 * BYPASSRLS is a property of the connected role, not of the SQL.
 *
 * This is the one assumption the whole architecture rests on and the only check
 * that verifies it against reality rather than against configuration.
 */
let identityVerified: Promise<void> | undefined;

async function assertRestrictedIdentity(tx: {
  $queryRaw: <T>(q: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
}): Promise<void> {
  const rows = await tx.$queryRaw<
    { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
  >`SELECT current_user, r.rolsuper, r.rolbypassrls
      FROM pg_roles r WHERE r.rolname = current_user`;
  const row = rows[0];
  if (!row || row.rolsuper || row.rolbypassrls) {
    throw new Error(
      `withOrg refuses to run: connected as '${row?.current_user ?? 'unknown'}' ` +
        `(rolsuper=${row?.rolsuper}, rolbypassrls=${row?.rolbypassrls}). RLS is the ` +
        `authoritative tenant filter and a superuser or BYPASSRLS role silently ` +
        `ignores it. Check APP_DATABASE_URL points at makrai_app — see ADR-0001.`,
    );
  }
}

export const appClient = hmrSingleton('appClient', createAppClient);

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
export function withOrg<T>(ctx: OrgContext, cb: (tx: TenantTx) => Promise<T>): Promise<T> {
  // An org id is never legitimately blank. Without this, an empty or missing
  // orgId is *safely* indistinguishable (NULLIF fails closed, so reads return
  // zero rows) but *diagnostically* dangerous: the user sees an empty dashboard
  // identical to a genuinely empty organization, and D-069 records the exact
  // trap — users.lastActiveOrgId is unconstrained and may be stale or blank.
  // Throwing converts a confusing screen into a stack trace at the caller.
  // Rejected, not thrown synchronously. withOrg's declared type is Promise<T>,
  // so a caller written as `withOrg(...).catch(handle)` would crash on a sync
  // throw instead of reaching its handler — a uniform contract matters more
  // here than brevity, since this is the error path callers are least likely to
  // have exercised.
  // `.trim()` because '   ' passed the length check and produced exactly the
  // indistinguishable-empty-dashboard this guard exists to prevent.
  if (typeof ctx.orgId !== 'string' || ctx.orgId.trim().length === 0) {
    return Promise.reject(
      new Error(
        'withOrg: ctx.orgId is missing or empty. This is a caller bug, not an empty ' +
          'organization — establishing a legitimate orgId is requireOrgContext’s job.',
      ),
    );
  }

  return appClient.$transaction(async (tx) => {
    if (identityVerified === undefined) {
      identityVerified = assertRestrictedIdentity(tx).catch((e: unknown) => {
        identityVerified = undefined; // a transient failure must not poison the process
        throw e;
      });
    }
    await identityVerified;

    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${ctx.orgId}, true)`;
    return cb(tx);
  });
}
