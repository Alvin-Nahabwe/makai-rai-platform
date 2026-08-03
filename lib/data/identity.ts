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
  'delete',
  'deleteMany',
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

function createIdentityClient(): NonTenantClient {
  const base = new PrismaClient({
    adapter: new PrismaPg(
      new Pool({ connectionString: requireDatabaseUrl('DATABASE_URL'), max: 5 }),
    ),
  });

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
