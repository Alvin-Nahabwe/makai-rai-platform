import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { testDb, resetDb } from '../helpers/db';
import * as preauth from '../../lib/data/preauth';
import { identityDb } from '../../lib/data/identity';
import type { OrgContext } from '../../lib/data/tenant';

/**
 * Both suites below pin defects found by the C6 whole-branch security review on
 * 2026-08-03 and reproduced live before they were fixed. Neither was caught by
 * the per-task threat passes, which is why they are pinned here rather than
 * trusted to review: both are fail-OPEN, and both live on the owner connection
 * where no database control exists to catch them.
 */

async function seedTwoOrgs() {
  const user = await testDb.user.create({
    data: { email: 'victim@x.org', name: 'victim', passwordHash: 'x' },
  });
  const a = await testDb.organization.create({ data: { name: 'A', slug: 'org-a' } });
  const b = await testDb.organization.create({ data: { name: 'B', slug: 'org-b' } });
  await testDb.membership.create({ data: { orgId: a.id, userId: user.id, role: 'owner' } });
  await testDb.membership.create({ data: { orgId: b.id, userId: user.id, role: 'admin' } });
  await testDb.project.create({ data: { orgId: a.id, name: 'A proj', createdById: user.id } });
  await testDb.invitation.create({
    data: {
      orgId: a.id, email: 'invitee@x.org', role: 'owner',
      tokenHash: createHash('sha256').update('secret-token-a').digest('hex'),
      invitedById: user.id, expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { user, a, b };
}

/**
 * Prisma DROPS a `where` key whose value is `undefined` rather than rejecting it
 * — strictUndefinedChecks is a preview feature and the schema enables no preview
 * features. On preauth, which runs as SUPERUSER/BYPASSRLS, that turned a missing
 * argument into "any row on the platform". Before the fix,
 * invitationByToken(undefined) returned a live pending invitation including its
 * token and an `owner` role.
 *
 * The declared parameter types say `string`, so these casts are not paranoia:
 * they reproduce exactly what a route handler does when it reads
 * `await req.json()` (typed `any`) and the field is absent.
 */
describe('preauth rejects a missing lookup key instead of matching every row', () => {
  beforeEach(resetDb);

  it('invitationByToken(undefined) returns null, not someone else\'s live invitation', async () => {
    await seedTwoOrgs();
    expect(await preauth.invitationByToken(undefined as unknown as string)).toBeNull();
  });

  it('orgBySlug(undefined) returns null, not an arbitrary tenant', async () => {
    await seedTwoOrgs();
    expect(await preauth.orgBySlug(undefined as unknown as string)).toBeNull();
  });

  it('membershipsForUser(undefined) returns [], not the platform membership graph', async () => {
    await seedTwoOrgs();
    expect(await preauth.membershipsForUser(undefined as unknown as string)).toEqual([]);
  });

  it('rejects the empty string too, which Prisma would treat as a real key', async () => {
    await seedTwoOrgs();
    expect(await preauth.invitationByToken('')).toBeNull();
    expect(await preauth.orgBySlug('')).toBeNull();
    expect(await preauth.membershipsForUser('')).toEqual([]);
  });

  it('still returns the real row for a valid key — the guard is not a blanket deny', async () => {
    await seedTwoOrgs();
    const inv = await preauth.invitationByToken('secret-token-a');
    expect(inv).not.toBeNull();
    expect(await preauth.orgBySlug('org-a')).not.toBeNull();
  });
});

/**
 * Pick<PrismaClient,'user'> hands over the WHOLE user delegate, and User has
 * relations to five tenant models. Before the fix, an `include` reached other
 * organizations' projects, the full membership graph and live invitation tokens
 * over the BYPASSRLS owner connection — type-checking cleanly, passing lint, and
 * passing every RLS test, because it never touches makrai_app.
 */
/**
 * These attack the CLASS, not the instances.
 *
 * The previous version of this suite pinned four shapes, all of which named a
 * tenant relation as a direct child of `include`/`data`. It passed — and the
 * guard was bypassed by nested `include`, `where: { OR: [...] }`, `_count`,
 * array `orderBy`, and `upsert`'s `create`/`update` clauses, every one of which
 * was reproduced live against the owner connection. Four independent reviewers
 * found this. The lesson is not "add four more cases": it is that a guard test
 * must probe the shape space, so each case below is a different *traversal*
 * rather than a different relation name.
 */
describe('identityDb refuses to traverse into tenant data, at any depth or shape', () => {
  beforeEach(resetDb);

  it('rejects a direct include', async () => {
    await seedTwoOrgs();
    await expect(
      identityDb.user.findMany({ include: { memberships: true } } as never),
    ).rejects.toThrow(/tenant data and this client bypasses RLS/);
  });

  it('rejects a relation reached by NESTING through an allowed relation', async () => {
    await seedTwoOrgs();
    await expect(
      identityDb.consentRecord.findMany({
        include: { user: { include: { memberships: { include: { org: true } } } } },
      } as never),
    ).rejects.toThrow(/tenant data/);
  });

  it('rejects a relation hidden inside a where ARRAY combinator', async () => {
    await seedTwoOrgs();
    await expect(
      identityDb.user.findMany({
        where: { OR: [{ memberships: { some: { role: 'owner' } } }] },
      } as never),
    ).rejects.toThrow(/tenant data/);
  });

  it('rejects a relation counted through _count', async () => {
    await seedTwoOrgs();
    await expect(
      identityDb.user.findMany({
        select: { id: true, _count: { select: { projects: true } } },
      } as never),
    ).rejects.toThrow(/tenant data/);
  });

  it('rejects a relation in the ARRAY form of orderBy', async () => {
    await seedTwoOrgs();
    await expect(
      identityDb.user.findMany({ orderBy: [{ memberships: { _count: 'desc' } }] } as never),
    ).rejects.toThrow(/tenant data/);
  });

  it('rejects nested writes via update AND via upsert create/update clauses', async () => {
    const { user, b } = await seedTwoOrgs();
    await expect(
      identityDb.user.update({
        where: { id: user.id },
        data: { memberships: { updateMany: { where: {}, data: { role: 'viewer' } } } },
      } as never),
    ).rejects.toThrow(/tenant data/);
    await expect(
      identityDb.user.upsert({
        where: { email: 'attacker@x.org' },
        create: {
          email: 'attacker@x.org', name: 'a', passwordHash: 'x',
          memberships: { create: { orgId: b.id, role: 'owner' } },
        },
        update: { memberships: { updateMany: { where: {}, data: { role: 'viewer' } } } },
      } as never),
    ).rejects.toThrow(/tenant data/);
  });

  /**
   * Narrowed at RUNTIME by construction, not by interception.
   *
   * The previous attempt used a Proxy that denied unknown property names. An
   * adversarial review escaped it through `identityDb.user.$parent` — an own
   * property of Prisma's delegate pointing back at the *unproxied* client, from
   * which `.project.findMany()`, `.$queryRawUnsafe(...)` and a cross-org
   * `membership.create` all worked — and separately through symbol keys, which
   * the trap's `typeof prop === 'string'` test skipped.
   *
   * So these assert ABSENCE, not denial: the surface is built from an explicit
   * list, and a property that was never copied cannot be reached by any route.
   */
  it('exposes exactly the constructed surface — nothing to escape through', async () => {
    const surface = identityDb as unknown as Record<string, unknown>;
    expect(Object.keys(surface).sort()).toEqual([
      '$connect', '$disconnect', 'consentRecord', 'user',
    ]);
    for (const forbidden of ['project', 'membership', 'invitation', '$queryRawUnsafe', '$transaction', '$extends']) {
      expect(surface[forbidden]).toBeUndefined();
    }
    expect(Object.getOwnPropertySymbols(surface)).toEqual([]);
  });

  /**
   * Fix round 3 (task-6-report.md). `identityDb` used to be a directly
   * `Object.freeze()`'d object; `Object.isFrozen(identityDb)` reported
   * `true` and every mutation attempt threw as an inherent property of
   * that freeze. Fix round 2 (D-156) wrapped every `hmrSingleton` client
   * — `identityDb` included — in a lazy `Proxy` so construction (and
   * `requireDatabaseUrl`'s check) defers to first real use instead of
   * running at module-import time, which was breaking `next build`. Proxy
   * invariants force `Object.isFrozen`/`Object.isExtensible` to report
   * against the PLACEHOLDER target (always extensible, never frozen —
   * freezing it would defeat the lazy initialisation the Proxy exists
   * for), so `Object.isFrozen(identityDb)` now reports `false`. See
   * `lib/data/identity.ts`'s own "What enforces what" comment for the
   * full explanation; this is the row that comment now sends a reader to.
   *
   * The BEHAVIOURAL guarantee — mutation is rejected — is intact,
   * enforced by `hmrSingleton`'s explicit `set`/`deleteProperty`/
   * `defineProperty` traps (delegating to the real, still-`Object.freeze`d
   * instance) rather than by `Object.freeze` being directly observable
   * through the wrapper. Nothing pinned that fact until now: reachability
   * (the surface-exposure test above) and non-extensibility (below) are
   * DIFFERENT claims — a Proxy could in principle expose exactly the right
   * four names while still being freely mutable — and only the first was
   * ever tested. All 1290 tests stayed green through the change that made
   * `Object.isFrozen` start reporting `false`, which is exactly the "a
   * control's enforcement moved and nothing verified the new one" shape
   * this project keeps re-finding.
   *
   * STRICT MODE, stated rather than assumed: this file uses `import`/
   * `export` at its own top level, and module code is UNCONDITIONALLY
   * strict mode per the ECMAScript specification — a language-level
   * guarantee for any file shaped like this one, not a bundler setting or
   * a runtime flag that could silently differ. That is what makes
   * `surface.evil = x` on a trap that returns `false` THROW below, rather
   * than silently no-op the way the identical trap would in a sloppy-mode
   * context — where `expect(surface.evil).toBeUndefined()` alone would
   * still pass (the mutation genuinely does not stick either way) while
   * proving nothing about the LOUD rejection this test exists to pin.
   * `expect(() => {...}).toThrow(TypeError)` is deliberately the shape:
   * it can only pass under strict-mode throw semantics.
   *
   * NON-VACUITY, and an honest correction of the naive plan for it: the
   * intent was "remove one trap, watch exactly its own test go red."
   * Removing `set` ALONE changes nothing — every test here stays green —
   * because `hmrSingleton`'s default (no-trap) `[[Set]]` behaviour falls
   * through to `CreateDataProperty` on the receiver, which re-enters via
   * `defineProperty` regardless. `set` is FULLY REDUNDANT with
   * `defineProperty` for THIS test specifically (kept anyway, as an
   * independent, non-obscure rejection path — see `lib/data/connection.ts`'s
   * own comment on `new Proxy` for the full reasoning). The test below is
   * still non-vacuous, proven correctly rather than by the originally
   * planned method: removing `set` AND `defineProperty` TOGETHER is what
   * turns it red (`lib/data/connection.ts`'s history carries both
   * individual and combined removals). `deleteProperty` and
   * `defineProperty`, tested individually below, each ARE independently
   * load-bearing — removing either ALONE turns exactly its own test red,
   * confirmed the same way.
   */
  it('rejects assignment of a new property (TypeError, strict mode)', () => {
    const surface = identityDb as unknown as Record<string, unknown>;
    expect(() => {
      surface.evil = 'should not stick';
    }).toThrow(TypeError);
    expect(surface.evil).toBeUndefined();
  });

  it('rejects delete of an EXISTING property (TypeError, strict mode) — deleting a property that was never there would trivially "succeed" regardless of any guard, so this targets a real one', () => {
    const surface = identityDb as unknown as Record<string, unknown>;
    expect(() => {
      delete surface.user;
    }).toThrow(TypeError);
    expect(typeof surface.user).toBe('object');
  });

  it('rejects Object.defineProperty', () => {
    const surface = identityDb as unknown as Record<string, unknown>;
    expect(() => {
      Object.defineProperty(surface, 'evil', { value: 'x', configurable: true });
    }).toThrow(TypeError);
    expect(surface.evil).toBeUndefined();
  });

  it('the surface is still EXACTLY the four names after every mutation attempt above — reachability (tested above) and non-extensibility (this) are different claims, both now pinned', () => {
    const surface = identityDb as unknown as Record<string, unknown>;
    expect(Object.keys(surface).sort()).toEqual([
      '$connect', '$disconnect', 'consentRecord', 'user',
    ]);
  });

  it('gives the delegates no back-reference to the unguarded client', async () => {
    const userDelegate = (identityDb as unknown as Record<string, Record<string, unknown>>).user;
    expect(userDelegate.$parent).toBeUndefined();
    expect(Object.getOwnPropertySymbols(userDelegate)).toEqual([]);
    // and only the operations we deliberately exposed
    expect(Object.keys(userDelegate)).not.toContain('fields');
    expect(typeof userDelegate.findMany).toBe('function');
  });

  it('rejects the _count SHORTHAND, which expands to every relation', async () => {
    await seedTwoOrgs();
    await expect(
      identityDb.user.findMany({ include: { _count: true } } as never),
    ).rejects.toThrow(/_count/);
  });

  it('still serves plain identity reads — the guard is not a blanket deny', async () => {
    await seedTwoOrgs();
    const users = await identityDb.user.findMany({ where: { email: 'victim@x.org' } });
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('victim@x.org');
    const withCounts = await identityDb.user.findMany({
      select: { id: true, _count: { select: { consentRecords: true } } },
    } as never);
    expect(withCounts).toHaveLength(1);
  });
});

describe('withOrg refuses a missing org id instead of silently returning nothing', () => {
  beforeEach(resetDb);

  it('throws on an empty orgId rather than rendering an empty organization', async () => {
    const { withOrg } = await import('../../lib/data/tenant');
    // OrgContext is branded (Task 5, D-089); this test deliberately probes
    // withOrg below the authorization layer with a malformed/absent orgId,
    // so it uses the documented `as OrgContext` escape hatch rather than
    // createOrgContext, which only requireOrgContext may call.
    await expect(
      withOrg({ orgId: '', role: 'admin' } as OrgContext, async (tx) => tx.project.findMany()),
    ).rejects.toThrow(/caller bug, not an empty organization/);
    await expect(
      withOrg({ orgId: undefined as unknown as string, role: 'admin' } as OrgContext, async (tx) =>
        tx.project.findMany()),
    ).rejects.toThrow(/caller bug/);
  });
});
