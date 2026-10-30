import { Prisma, PrismaClient, type OrgRole } from '@prisma/client';
import type {
  CalendarDate, FindingEventKind, FindingSource, MitigationStatus, ReminderKind, ReminderOutcome, Stage, UtcInstant,
} from '../../types/record';
import { isUniqueViolation } from './pgErrors';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { can, type Action } from '../authz/policy';
import { stampReference, withUnavailableStamp } from '../http/supportReference';
import { assertUnprivilegedRole, hmrSingleton, requireDatabaseUrl } from './connection';
import { isDatabaseUnavailable } from './pgErrors';

/**
 * Branded so `withOrg`/`assertCan` structurally cannot be called with a
 * hand-built object — `withOrg({ orgId: body.orgId, role: 'owner' })` is a
 * type error, because the object literal has no `[orgContextBrand]` field.
 *
 * HONEST LIMIT: this stops *accidental* construction, not a deliberate
 * `as OrgContext` cast — TypeScript's structural typing cannot prevent a
 * cast, only a plain object literal. The runtime guarantee comes from
 * `createOrgContext` below having exactly one legitimate caller,
 * `requireOrgContext` (lib/auth/context.ts) — enforced by ESLint
 * (eslint.config.mjs) and by `__tests__/integration/org-context.test.ts`,
 * which enumerates every importer of `createOrgContext` from disk rather
 * than relying on a reviewer's memory (D-089).
 *
 * CHECKED, 2026-08-05 (CRITICAL-1): this ban was the one that happened to
 * SURVIVE a config collision that silently deleted the `lib/db`/`auth`
 * bans elsewhere in the same file — "enforced by ESLint" was true here by
 * accident of ordering, not by anything that verified it. `eslint.config.mjs`
 * now carries all three bans in one non-colliding config object, and
 * `__tests__/lint/effective-config.test.ts` pins the RESOLVED config (not
 * this file's source text) so a future collision fails a test instead of
 * silently reading true forever.
 */
declare const orgContextBrand: unique symbol;
export type OrgContext = {
  readonly orgId: string;
  readonly role: OrgRole;
  readonly [orgContextBrand]: true;
};

/**
 * Do not call this directly. Call `requireOrgContext(slug, action)`
 * (lib/auth/context.ts) — it is the only place permitted to mint an
 * `OrgContext`, because it is the only place that has proven the six facts
 * ADR-0001 requires (valid session, active user, org exists and is not
 * soft-deleted, active membership, `can()` on the DB-read role, and an
 * `orgId` read from the database rather than taken from client input).
 * Restricted by ESLint and by the generated importer-enumeration test named
 * on the type above.
 */
export function createOrgContext(orgId: string, role: OrgRole): OrgContext {
  return { orgId, role } as OrgContext;
}

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

/**
 * The 404 sibling `ForbiddenError` was missing (D-089 item 2), defined here
 * alongside it so the status mapping is total rather than inferred later by
 * whoever writes the first error handler. Thrown for BOTH "slug unknown" and
 * "slug exists but caller is not a member" — deliberately carrying no detail
 * (no slug, no reason) so the two cases stay indistinguishable in type AND
 * message. ADR-0001: unauthorized access to an existing resource returns 404,
 * never 403 — org existence is not leaked to slug probing.
 */
export class NotFoundError extends Error {
  constructor() {
    super('not found');
    this.name = 'NotFoundError';
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
  return withUnavailableStamp(
    new PrismaClient({
      adapter: new PrismaPg(
        new Pool({ connectionString: requireDatabaseUrl('APP_DATABASE_URL'), max: 10, options: '' }),
      ),
    }),
  );
}

/**
 * Memo for `withOrg`'s check, once per process, on the live connection, that the app
 * lane is not a superuser or BYPASSRLS role (`assertUnprivilegedRole`,
 * lib/data/connection.ts, which documents why a URL check is not enough). The server
 * also runs that check on both lanes at start (`verifyDatabaseRoles`); this one stays
 * because it costs one query per process and holds even where `register()` never ran.
 */
let identityVerified: Promise<void> | undefined;

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
export function withOrg<T>(
  ctx: OrgContext,
  cb: (tx: TenantTx) => Promise<T>,
  options?: WithOrgOptions,
): Promise<T> {
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

  return inOrg(ctx.orgId, cb, options);
}

/**
 * `withOrg`'s third parameter (00-contract.md, Services, K0a; gap G066). `isolationLevel`
 * defaults to the database's (READ COMMITTED); REV-a, DOC-a and EXP read one snapshot at
 * `RepeatableRead` (NFR-INT-10). `timeoutMs` is Prisma's interactive-transaction `timeout`
 * (default 5000 ms); EXP's team export takes one long snapshot (ADR-C7).
 */
export type WithOrgOptions = { isolationLevel?: 'ReadCommitted' | 'RepeatableRead'; timeoutMs?: number };

/**
 * The one transaction body behind `withOrg` and the reminder lane's methods: the role check
 * once per process, then the organisation GUC, transaction-scoped and parameterised, then `cb`.
 * The caller has already refused a blank organisation id.
 */
function inOrg<T>(orgId: string, cb: (tx: TenantTx) => Promise<T>, options?: WithOrgOptions): Promise<T> {
  // A failure to connect happens in $transaction itself, before any operation runs, so the client's hook cannot see
  // it: the unavailable error is stamped with its support reference here, for withOrg and the reminder lane alike (NFR-OBS-05).
  return appClient.$transaction(
    async (tx) => {
      if (identityVerified === undefined) {
        identityVerified = assertUnprivilegedRole(tx, 'APP_DATABASE_URL').catch((e: unknown) => {
          identityVerified = undefined; // a transient failure must not poison the process
          throw e;
        });
      }
      await identityVerified;

      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      return cb(tx);
    },
    {
      ...(options?.isolationLevel === undefined ? {} : { isolationLevel: Prisma.TransactionIsolationLevel[options.isolationLevel] }),
      ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    },
  ).catch((e: unknown) => {
    if (isDatabaseUnavailable(e)) stampReference(e);
    throw e;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The reminder lane (SRS 6.6, ADR-C5; 00-contract.md, Services, K0a).
// ─────────────────────────────────────────────────────────────────────────────

/** The rows the reminder run computes follow-up state from, for one organisation. */
export type FollowUpSourceRows = {
  findings: Array<{ id: string; projectId: string; stage: Stage; source: FindingSource }>;
  events: Array<{ findingId: string; kind: FindingEventKind; findingSeq: number }>;
  acceptedRisks: Array<{ findingId: string; findingSeq: number }>;
  currentMitigations: Array<{
    versionId: string; mitigationId: string; findingId: string; ownerUserId: string; dueDate: CalendarDate;
    status: MitigationStatus; findingSeq: number;
  }>;
  archivedProjectIds: string[];
};
export type ReminderLogRow = {
  mitigationId: string; dueDate: CalendarDate; kind: ReminderKind; attempt: number; outcome: ReminderOutcome; at: UtcInstant;
};
export type ReminderLogInsert = Omit<ReminderLogRow, 'at'> & { failureCode: string | null };

/**
 * What the reminder run may do in one organisation, and nothing more: exactly these five
 * members. Each method runs its own short transaction on the app lane with the organisation
 * set, so no transaction handle reaches the caller (finding F13), and `reminder_log` is reached
 * through nothing else (NFR-SEC-09).
 */
export interface ReminderLane {
  readonly orgId: string;
  followUpRows(): Promise<FollowUpSourceRows>;
  /** The current role of each id that is a member of the lane's organisation; a non-member is absent (FR-FUP-05). */
  memberRoles(userIds: readonly string[]): Promise<Map<string, OrgRole>>;
  reminderLogRows(mitigationIds: readonly string[]): Promise<ReminderLogRow[]>;
  /** 'duplicate' when a unique key of reminder_log refuses the row (9.5 line 3656; gap G091). */
  insertReminderLog(row: ReminderLogInsert): Promise<'inserted' | 'duplicate'>;
}

/**
 * The one way the reminder run reaches tenant rows without a signed-in member (SRS 6.6, ADR-C5).
 * Only `lib/reminders/job.ts` may import it: `__tests__/lint/restricted-imports.test.ts` scans
 * the source for the name in every import form. The lane is frozen and holds no transaction.
 */
export async function systemContext<T>(orgId: string, purpose: 'reminders', cb: (lane: ReminderLane) => Promise<T>): Promise<T> {
  if (typeof orgId !== 'string' || orgId.trim().length === 0) {
    throw new Error('systemContext: orgId is missing or empty.');
  }
  if (purpose !== 'reminders') {
    throw new Error(`systemContext: unknown purpose ${String(purpose)}.`);
  }

  const lane: ReminderLane = {
    orgId,

    followUpRows: () =>
      inOrg(orgId, async (tx): Promise<FollowUpSourceRows> => {
        const [findings, events, acceptedRisks, currentMitigations, archived] = await Promise.all([
          tx.finding.findMany({ select: { id: true, projectId: true, stage: true, source: true }, orderBy: { id: 'asc' } }),
          tx.findingEvent.findMany({ select: { findingId: true, kind: true, findingSeq: true }, orderBy: [{ findingId: 'asc' }, { findingSeq: 'asc' }] }),
          tx.acceptedRisk.findMany({ select: { findingId: true, findingSeq: true }, orderBy: [{ findingId: 'asc' }, { findingSeq: 'asc' }] }),
          tx.$queryRaw<FollowUpSourceRows['currentMitigations']>`
            SELECT DISTINCT ON ("mitigationId") "id" AS "versionId", "mitigationId", "findingId", "ownerUserId",
              to_char("dueDate", 'YYYY-MM-DD') AS "dueDate", "status", "findingSeq"
            FROM "mitigation_versions"
            ORDER BY "mitigationId", "versionNumber" DESC`,
          tx.project.findMany({ where: { archivedAt: { not: null } }, select: { id: true }, orderBy: { id: 'asc' } }),
        ]);
        return {
          findings: findings.map((f) => ({ id: f.id, projectId: f.projectId, stage: f.stage as Stage, source: f.source as FindingSource })),
          events: events.map((e) => ({ findingId: e.findingId, kind: e.kind as FindingEventKind, findingSeq: e.findingSeq })),
          acceptedRisks,
          currentMitigations,
          archivedProjectIds: archived.map((p) => p.id),
        };
      }),

    memberRoles: (userIds) =>
      inOrg(orgId, async (tx) => {
        const rows = await tx.membership.findMany({
          where: { userId: { in: [...new Set(userIds)] }, status: 'active' },
          select: { userId: true, role: true },
        });
        return new Map(rows.map((m) => [m.userId, m.role]));
      }),

    reminderLogRows: (mitigationIds) =>
      inOrg(orgId, (tx) => tx.$queryRaw<ReminderLogRow[]>`
        SELECT "mitigationId", to_char("dueDate", 'YYYY-MM-DD') AS "dueDate", "kind", "attempt", "outcome",
          to_char("at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "at"
        FROM "reminder_log"
        WHERE "mitigationId" = ANY (${[...mitigationIds]}::text[])
        ORDER BY "mitigationId", "dueDate", "kind", "attempt", "at", "id"`),

    insertReminderLog: async (row) => {
      try {
        await inOrg(orgId, (tx) => tx.reminderLog.create({
          data: {
            orgId, mitigationId: row.mitigationId, dueDate: new Date(`${row.dueDate}T00:00:00.000Z`), kind: row.kind,
            attempt: row.attempt, outcome: row.outcome, failureCode: row.failureCode,
          },
        }));
        return 'inserted' as const;
      } catch (e) {
        // Only a unique violation is the expected 'duplicate'; anything else propagates.
        if (isUniqueViolation(e)) return 'duplicate' as const;
        throw e;
      }
    },
  };

  return cb(Object.freeze(lane));
}
