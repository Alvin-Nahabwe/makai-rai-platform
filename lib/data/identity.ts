import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { hmrSingleton, requireDatabaseUrl } from './connection';

/**
 * Non-tenant data only: User and ConsentRecord. Login reads User before any
 * organization is known, so withOrg structurally cannot serve these.
 *
 * This client connects as `makrai`, the schema owner — a SUPERUSER with
 * BYPASSRLS. Superusers bypass RLS unconditionally and FORCE does not apply to
 * them, so a tenant query through this client returns every organization's rows
 * and no database control can stop it. Everything below exists because of that.
 *
 * ── What enforces what, stated exactly, because this comment has been wrong
 *    twice and each time a reviewer trusted it ──
 *
 *   1. The `NonTenantClient` type (compile time) — a mapped type over the two
 *      allowed models and the operations actually exposed. Fails CLOSED on
 *      models Plan 1b adds and on operations nobody sanctioned. **Erased at
 *      runtime**, so on its own it stops nothing on an `any`-typed path.
 *   2. `createIdentityClient`'s returned object (runtime) — the surface is BUILT
 *      from `EXPOSED_OPERATIONS`, so nothing outside it exists to reach. This is
 *      construction, not interception; see that constant's comment for why the
 *      distinction is the whole point.
 *   3. `assertNoTenantRelation` (runtime) — relation traversal *within* the two
 *      allowed delegates, over the entire argument tree.
 *
 * History worth keeping, because it explains the shape of both (2) and (3), and
 * because every step of it was a fix that looked complete. v1 used `Omit<>` and
 * leaked via `$transaction`. v2 used `Pick<>` and leaked via
 * `include: { memberships: … }`. v3 added a guard over five named clauses at
 * depth 1 and leaked via nested `include`, `where: { OR: [...] }`, `_count`,
 * array `orderBy` and `upsert`. v4 made the walk recursive and wrapped the
 * client in a Proxy — and leaked via `user.$parent`, an own property of Prisma's
 * delegate pointing back at the unproxied client, and via symbol keys the trap
 * did not test. v5 is the current one: stop denying, start constructing.
 */

/**
 * Every relation reachable from the two allowed delegates, classified.
 *
 * The key type is `keyof Prisma.UserInclude | keyof Prisma.ConsentRecordInclude`,
 * so this is not a hand-maintained list: adding a relation to `User` or
 * `ConsentRecord` in schema.prisma makes this object fail to compile until
 * someone classifies it. That is deliberate — the previous version asked
 * reviewers to remember, and AGENTS.md §0 is explicit that a rule with no
 * observable trigger does not fire.
 *
 * `_count` and the identity relations are 'identity' rather than 'tenant'
 * because the walk recurses *through* them: `_count.select.projects` is caught
 * on `projects`, not on `_count`. Blocking them outright would also block
 * legitimate identity-only counts.
 */
type IdentityRelation = keyof Prisma.UserInclude | keyof Prisma.ConsentRecordInclude;

const RELATION_CLASS: Record<IdentityRelation, 'tenant' | 'identity'> = {
  projects: 'tenant',
  assessments: 'tenant',
  completedRemediations: 'tenant',
  memberships: 'tenant',
  sentInvitations: 'tenant',
  uploadedEvidence: 'tenant',
  consentRecords: 'identity',
  user: 'identity',
  _count: 'identity',
};

const TENANT_RELATIONS: ReadonlySet<string> = new Set(
  Object.entries(RELATION_CLASS)
    .filter(([, cls]) => cls === 'tenant')
    .map(([name]) => name),
);

/**
 * Walks the whole argument tree — every object and every array element, at any
 * depth — and rejects any key naming a tenant relation.
 *
 * Recursive rather than clause-listed on purpose. A clause list has to track
 * Prisma's argument grammar (`data` for update but `create`/`update` for upsert,
 * `AND`/`OR`/`NOT` inside `where`, `select` inside `_count`, arrays in
 * `orderBy`), and it was the drift between that list and the real grammar that
 * produced the previous bypasses.
 */
function assertNoTenantRelation(node: unknown, path = 'args'): void {
  if (node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    node.forEach((item, i) => assertNoTenantRelation(item, `${path}[${i}]`));
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    if (TENANT_RELATIONS.has(key)) {
      throw new Error(
        `identityDb: '${key}' at ${path}.${key} is tenant data and this client ` +
          `bypasses RLS (it connects as the schema owner). Route it through withOrg ` +
          `instead — see ADR-0001.`,
      );
    }
    // `_count: true` is the shorthand form and has no child keys for the walk to
    // reach — Prisma expands it to EVERY relation, so it reports cross-org
    // project, membership and invitation counts as a per-user oracle. Only the
    // explicit `_count: { select: { … } }` form can be checked by recursion.
    if (key === '_count' && (value === null || typeof value !== 'object')) {
      throw new Error(
        `identityDb: '_count' at ${path}._count must name the relations it counts ` +
          `(_count: { select: { … } }). The shorthand expands to every relation on ` +
          `the model, including tenant ones — see ADR-0001.`,
      );
    }
    assertNoTenantRelation(value, `${path}.${key}`);
  }
}

/**
 * The operations a caller may invoke on an allowed delegate.
 *
 * This is an ALLOWLIST used by CONSTRUCTION, not by interception, and that
 * distinction is the whole point. The previous attempt wrapped the client in a
 * Proxy that denied unknown property names — and an adversarial review walked
 * straight past it via `identityDb.user.$parent`, an own property of Prisma's
 * delegate pointing back at the unproxied client, from which
 * `.project.findMany()`, `.$queryRawUnsafe(…)` and a cross-org `membership.create`
 * all worked. Symbol keys skipped the trap entirely too, because it tested
 * `typeof prop === 'string'`.
 *
 * That is the fourth time on this branch a guard closed the doors it knew about
 * and left the class open. An interception guard is only ever as good as the
 * reachability graph its author imagined. So the object below is *built* from
 * these names: `$parent` is not absent because it is denied, it is absent
 * because nothing ever copies it.
 */
const EXPOSED_OPERATIONS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  // `delete` and `deleteMany` are deliberately ABSENT. Deleting a User cascades
  // through `memberships_userId_fkey ON DELETE CASCADE` into a tenant table, on
  // the BYPASSRLS owner connection — and `assertNoTenantRelation` cannot see it,
  // because `{ where: { id } }` names no relation. Reproduced live: deleting a
  // user silently removed their memberships in two organizations. Nothing in
  // Plan 1a deletes users; when Plan 1b needs to, it gets a named function that
  // tears the memberships down explicitly rather than via referential action.
  'count',
  'aggregate',
  'groupBy',
] as const;

type ExposedOperation = (typeof EXPOSED_OPERATIONS)[number];
type NonTenantModel = 'user' | 'consentRecord';

/**
 * Deliberately NOT `Pick<PrismaClient, 'user' | 'consentRecord'>`: that type
 * promises whole delegates, which is more than this client actually exposes, and
 * an over-promising type is what started this. It fails closed twice over — on
 * models it does not name, and on operations it does not name.
 */
type NonTenantClient = {
  [M in NonTenantModel]: Pick<PrismaClient[M], ExposedOperation>;
} & {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
};

/**
 * The raw, unguarded, superuser-connected client. Module-scoped (via its
 * own `hmrSingleton`, not re-instantiated per call) so `identityDb` below
 * and `scrubUserOnDeactivation` further down share ONE connection pool
 * instead of each opening their own — see `withOrg`'s comment in
 * lib/data/tenant.ts on why an extra unbudgeted pool per client matters
 * (`max_connections` is a shared, finite resource across every pool this
 * process opens).
 *
 * NEVER export this directly and never add a new caller of it without the
 * same scrutiny `identityDb`'s five-attempt history documents above: this
 * is the connection every guard in this file exists to stand between
 * application code and.
 */
function createBaseClient() {
  return new PrismaClient({
    adapter: new PrismaPg(
      new Pool({ connectionString: requireDatabaseUrl('DATABASE_URL'), max: 5, options: '' }),
    ),
  });
}

const base = hmrSingleton('identityBaseClient', createBaseClient);

function createIdentityClient(): NonTenantClient {
  // $extends is used only to inspect arguments; it never touches connection
  // state, so the Task-0 spike's NO-GO (which concerned set_config landing on a
  // different pooled connection) does not apply.
  const guardArgs = {
    $allOperations({
      args,
      query,
    }: {
      args: unknown;
      query: (a: unknown) => Promise<unknown>;
    }): Promise<unknown> {
      assertNoTenantRelation(args);
      return query(args);
    },
  };
  const guarded = base.$extends({
    query: { user: guardArgs, consentRecord: guardArgs } satisfies Record<
      NonTenantModel,
      typeof guardArgs
    >,
  });

  // Copy out only the named operations, bound to the guarded delegate. Nothing
  // else comes with them — no $parent, no symbols, no prototype chain back to
  // the client. Frozen so a later import cannot bolt anything on.
  const expose = <M extends NonTenantModel>(model: M): Pick<PrismaClient[M], ExposedOperation> => {
    const delegate = guarded[model] as unknown as Record<string, unknown>;
    const surface: Record<string, unknown> = {};
    for (const op of EXPOSED_OPERATIONS) {
      const fn = delegate[op];
      if (typeof fn === 'function') surface[op] = (fn as (...a: unknown[]) => unknown).bind(delegate);
    }
    return Object.freeze(surface) as Pick<PrismaClient[M], ExposedOperation>;
  };

  return Object.freeze({
    user: expose('user'),
    consentRecord: expose('consentRecord'),
    // Bound to the base client on purpose: these are lifecycle calls, and
    // routing them through the extended client made `this` the wrapper and
    // broke them outright in the previous attempt.
    $connect: () => base.$connect(),
    $disconnect: () => base.$disconnect(),
  }) as NonTenantClient;
}

export const identityDb: NonTenantClient = hmrSingleton('identityDb', createIdentityClient);

/**
 * Scatter-gather lookup of `{ name }` for a set of user ids, keyed by id.
 * Exists because `makrai_app` — the role `withOrg` connects as — has
 * `SELECT`/`INSERT`/`UPDATE`/`DELETE` explicitly REVOKED on `users` at the
 * database level (migration
 * `20260803062144_add_restricted_app_role/migration.sql`: "`REVOKE ALL ON
 * "users" FROM makrai_app`"), enforcing the same boundary
 * `assertNoTenantRelation` enforces from the other side. That means a
 * `withOrg`-scoped Prisma query can NEVER `include`/`select` a `user`
 * relation on `Project.createdBy`, `Assessment.user`, or
 * `RemediationItem.completedBy` — Postgres itself returns "permission
 * denied for table users" the instant such a query executes, independent
 * of RLS. Every caller that needs a display name alongside tenant data
 * fetches the tenant rows WITHOUT the relation (scalar `createdById`,
 * `userId`, `completedById` FK columns read directly off the tenant table
 * are fine — no join required), then calls this function on the identity
 * connection, then merges client-side.
 *
 * **Name only, deliberately** (fix round 1, Important finding 2). The
 * pre-port code this task replaced selected `createdBy: { select: { name:
 * true } }` — name only, never email. An earlier version of this function
 * returned `{ name, email }` unconditionally, which meant every one of its
 * six call sites started returning every referenced user's EMAIL in JSON —
 * including `GET .../projects` to a `viewer`, who never had that field
 * before and whose UI never rendered it (so the regression was invisible in
 * a browser, visible only in devtools/curl). The helper's own safety used
 * to rest entirely on call-site convention — every id happens to come from
 * an RLS-filtered row — which is weaker than every other boundary in this
 * module. Narrowing the return type is the fix: a caller cannot leak a
 * field this function does not hand back. No current caller needs email
 * (verified: none of the six call sites use `.email`); a future one that
 * does gets its own explicitly-named function rather than this one quietly
 * regaining a field every existing caller then re-inherits.
 */
export async function lookupUserNames(
  ids: readonly string[],
): Promise<Map<string, { name: string }>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const users = await identityDb.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, { name: u.name }]));
}

/**
 * Deactivate-and-scrub the caller's OWN account (`DELETE /api/users/me`)
 * and delete their `ConsentRecord` rows in the same transaction.
 *
 * `identityDb` deliberately exposes no `delete`/`deleteMany` at all (see
 * `EXPOSED_OPERATIONS` above) — that guard exists because a `User` delete
 * cascades into tenant tables (`memberships_userId_fkey ON DELETE CASCADE`)
 * on the BYPASSRLS connection, and `assertNoTenantRelation` cannot see a
 * cascade triggered by `{ where: { id } }`, which names no relation. This
 * function does NOT reopen that hole: it never deletes a `User` row (this
 * is deactivate-and-scrub, not delete — memberships are torn down
 * explicitly and separately, by the caller, BEFORE this runs, exactly as
 * that comment anticipates: "it gets a named function that tears the
 * memberships down explicitly rather than via referential action").
 *
 * `ConsentRecord` is the one row type this function deletes, and it is
 * safe to build by construction rather than by guard: the model carries no
 * `orgId` and nothing cascades FROM it (it is a leaf table — see
 * schema.prisma), and this function's argument shape is fixed and
 * hardcoded (`{ where: { userId } }`, `{ where: { id: userId }, data: {
 * six scalar fields } }`) — there is no caller-supplied `include`/`data`
 * tree for `assertNoTenantRelation` to need to walk, because none is ever
 * accepted as a parameter.
 *
 * Runs on `base`, not `identityDb`, because `identityDb`'s allowlist has
 * no delete operation to bind this to — going around the allowlist here is
 * the point, not a bypass of it: this is the one, singular, reviewed
 * exception the module's own history says to add as a named function
 * rather than by widening `EXPOSED_OPERATIONS` (which would hand every
 * future `identityDb.user`/`identityDb.consentRecord` caller a delete
 * capability none of them need).
 */
export async function scrubUserOnDeactivation(
  userId: string,
  randomPasswordHash: string,
): Promise<void> {
  await base.$transaction([
    base.user.update({
      where: { id: userId },
      data: {
        email: `deleted-${userId}@invalid`,
        name: 'Deleted user',
        passwordHash: randomPasswordHash,
        isActive: false,
        sessionEpoch: { increment: 1 },
      },
    }),
    base.consentRecord.deleteMany({ where: { userId } }),
  ]);
}
