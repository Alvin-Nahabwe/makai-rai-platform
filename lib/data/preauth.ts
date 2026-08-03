import {
  PrismaClient,
  type Membership,
  type Organization,
  type Invitation,
  type Prisma,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { hmrSingleton, requireDatabaseUrl } from './connection';

/**
 * The transaction handle for the owner-connection writes below. This is its
 * own alias rather than an import of `TenantTx` from `./tenant` — that module
 * is the org-scoped, GUC-bearing client, and this one deliberately bypasses
 * it entirely (see the module doc above). Both resolve to the same generated
 * `Prisma.TransactionClient`, but importing `tenant.ts` here would wire a
 * dependency between two modules whose whole point is to stay separate.
 */
type OwnerTx = Prisma.TransactionClient;

/**
 * The before-context reads and writes — and ONLY these.
 *
 * Some reads must happen before any org context exists: resolving which orgs a
 * user belongs to at login, mapping a URL slug to an organization, and looking
 * up an invitation by token. These are inherently cross-org ("which orgs am I
 * in" cannot be org-scoped), so no RLS policy can serve them; they run on the
 * owner connection, which bypasses RLS.
 *
 * One write belongs here for the same structural reason: registration must
 * create the *first* organization a user belongs to, and `withOrg` cannot do
 * that (see `bootstrapOrgWithOwner` below for why). `createOrgForUser` shares
 * the same connection for a later authenticated "create another org" action.
 *
 * That bypass is deliberate (ADR-0001) and must stay small. Do not add a
 * function here without deciding it is genuinely a before-context read or
 * write — __tests__/integration/preauth-surface.test.ts pins this module's
 * exports and will fail if the surface grows. The pin does not constrain what
 * the existing bodies return, so widening one (an added `include:`) is on the
 * reviewer.
 */

function createOwnerClient() {
  return new PrismaClient({
    adapter: new PrismaPg(
      new Pool({ connectionString: requireDatabaseUrl('DATABASE_URL'), max: 5, options: '' }),
    ),
  });
}

const ownerClient = hmrSingleton('preauthClient', createOwnerClient);

/**
 * Every lookup key in this module is validated before it reaches Prisma, and
 * that is a security control rather than defensive habit.
 *
 * Prisma DROPS a `where` key whose value is `undefined` instead of rejecting it
 * (its `strictUndefinedChecks` preview feature is off; the schema declares no
 * previewFeatures). On this module that turns a missing argument into "match any
 * row on the platform", and because these functions run on the OWNER connection
 * — SUPERUSER, BYPASSRLS — nothing downstream re-filters. Found by the C6
 * whole-branch security review and reproduced live 2026-08-03:
 * `invitationByToken(undefined)` returned a live pending invitation, token and
 * `owner` role included, to a caller who supplied nothing.
 *
 * The types say `string`, but the callers are route handlers reading
 * `await req.json()`, which is `any` — so the compiler will not catch it. Note
 * `null` already throws inside Prisma; `undefined` is the dangerous value.
 */
function lookupKey(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function membershipsForUser(
  userId: string,
): Promise<(Membership & { org: Organization })[]> {
  const key = lookupKey(userId);
  if (key === null) return Promise.resolve([]);
  return ownerClient.membership.findMany({
    where: { userId: key, status: 'active', org: { deletedAt: null } },
    include: { org: true },
  });
}

export function orgBySlug(slug: string): Promise<Organization | null> {
  const key = lookupKey(slug);
  if (key === null) return Promise.resolve(null);
  return ownerClient.organization.findFirst({ where: { slug: key, deletedAt: null } });
}

/**
 * Fails closed: an expired or already-actioned invitation is indistinguishable
 * from a nonexistent one. The trade-off is deliberate — the caller cannot render
 * "your invitation expired" from this alone. Plan 1b adds a separate, explicitly
 * named lookup if that message is wanted, rather than every caller having to
 * remember the two checks.
 *
 * `invitations.tokenHash` stores only a sha256 hex digest (D-097; enforced by
 * the `invitations_tokenHash_is_sha256_hex` CHECK) — the raw token is never
 * persisted, so a lookup must hash the caller's plaintext before comparing.
 * This mirrors Task 8's `acceptInvitation`, which hashes the same way.
 */
export function invitationByToken(token: string): Promise<Invitation | null> {
  const key = lookupKey(token);
  if (key === null) return Promise.resolve(null);
  const tokenHash = createHash('sha256').update(key).digest('hex');
  return ownerClient.invitation.findFirst({
    where: { tokenHash, status: 'pending', expiresAt: { gt: new Date() } },
  });
}

/**
 * The sanctioned before-context WRITE. `withOrg` structurally cannot create an
 * organization: the `organizations` policy is
 * WITH CHECK (id = NULLIF(current_setting('app.current_org_id', true), ''))
 * and a NEW organization is by definition not yet the current one (D-078).
 *
 * All four rows in ONE transaction: `identityDb` deliberately exposes no
 * `$transaction`, so splitting this across clients would permit the partial
 * state "user and organization exist, consents do not".
 *
 * There is no `role` parameter and there must never be one. Its sibling
 * `acceptInvitation` (Task 8) legitimately takes a role from the invitation
 * row; merging the two into one parameterised helper would be a
 * privilege-escalation vector on a connection that bypasses RLS. Both this
 * function and `createOrgForUser` below only ever grant `owner` on an
 * organization *created inside the same transaction* — neither takes an
 * existing org id, so there is no path for a caller to attach `owner` to an
 * org that already has members.
 *
 * CALLER OBLIGATION this function does not and cannot enforce: it writes
 * `termsAccepted: true` and a `granted: true` consent row unconditionally —
 * there is no `termsAccepted` parameter to withhold consent through. The
 * caller (today, only `app/api/auth/register/route.ts`) MUST have already
 * confirmed the user actually accepted the Terms of Service before calling
 * this. Any future second caller that skips that gate fabricates an
 * ISO-42001-relevant compliance record for a consent nobody gave.
 */
export function bootstrapOrgWithOwner(input: {
  email: string; name: string; passwordHash: string;
  orgName: string; researchConsent: boolean; ipAddress: string;
}): Promise<{ userId: string; orgId: string; slug: string }> {
  return ownerClient.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email, name: input.name, passwordHash: input.passwordHash,
        termsAccepted: true, termsAcceptedAt: new Date(),
        researchConsent: input.researchConsent,
      },
    });
    const org = await createOwnedOrg(tx, user.id, input.orgName);
    await tx.consentRecord.createMany({
      data: [
        { userId: user.id, consentType: 'terms_of_service', granted: true, ipAddress: input.ipAddress },
        { userId: user.id, consentType: 'privacy_policy',   granted: true, ipAddress: input.ipAddress },
        ...(input.researchConsent
          ? [{ userId: user.id, consentType: 'research_data_usage' as const, granted: true, ipAddress: input.ipAddress }]
          : []),
      ],
    });
    return { userId: user.id, orgId: org.id, slug: org.slug };
  });
}

/**
 * Makes an already-existing user the owner of a brand-new second
 * organization. Same "no role parameter, always a fresh org" shape as
 * `bootstrapOrgWithOwner` above, for the same reason.
 *
 * CALLER OBLIGATION this function does not and cannot enforce: `input.userId`
 * is trusted as given — there is no check that it is the caller's own
 * authenticated identity. It is FK-constrained (an unknown id fails closed
 * with a foreign-key violation) but not identity-constrained, so the worst
 * case of a wrong caller is creating an organization owned by someone else,
 * never privilege escalation on an *existing* org (see the invariant above).
 * There is currently no route calling this — Task 4 (`requireIdentity()`)
 * wires the first one — and that caller MUST pass the id of the currently
 * authenticated session, not a client-supplied value.
 */
export function createOrgForUser(
  input: { userId: string; orgName: string },
): Promise<{ orgId: string; slug: string }> {
  return ownerClient.$transaction(async (tx) => {
    const org = await createOwnedOrg(tx, input.userId, input.orgName);
    return { orgId: org.id, slug: org.slug };
  });
}

/**
 * Shared by `bootstrapOrgWithOwner` and `createOrgForUser`: create a fresh
 * organization and attach `userId` to it as `owner` in the same transaction.
 * Extracted so the org-creation-then-owner-membership pairing exists in one
 * place rather than two, matched at the call sites above.
 */
async function createOwnedOrg(
  tx: OwnerTx,
  userId: string,
  orgName: string,
): Promise<{ id: string; slug: string }> {
  const org = await createOrgInTx(tx, orgName);
  await tx.membership.create({ data: { orgId: org.id, userId, role: 'owner' } });
  return org;
}

/**
 * Derived server-side, never chosen. A "that slug is taken" error is an
 * org-existence oracle (D-101), so this has no way to report a collision to
 * its caller — see `createOrgInTx` below, which retries silently instead.
 *
 * Deliberately no Unicode-normalisation step: an earlier draft of this
 * function ran `.normalize('NFKD')` and stripped combining marks (U+0300–
 * U+036F) before collapsing non-alphanumerics, on the theory that accented
 * input should fold to its base letter (e.g. "é" -> "e"). Empirically it does
 * not — `normalize('NFKD')` does not decompose "ø" (it has no canonical
 * decomposition), so that draft turned "Ünïcødé & Symbols!!" into
 * "unic-de-symbols", not the "n-c-d-symbols" this module is required to
 * produce. Every non-ASCII letter is therefore treated the same as any other
 * non-alphanumeric separator, with no normalisation pass in front of it.
 */
export function deriveSlug(orgName: string): string {
  return orgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 48)          // truncate BEFORE trimming: truncating after would
    .replace(/^-+|-+$/g, ''); // let a mid-word cut reintroduce a trailing '-'
}

/**
 * Only a UNIQUE violation (Prisma P2002, backed by the `organizations.slug`
 * unique constraint) may be retried — any other error propagates, because
 * swallowing it would be exactly the silent-failure class this branch has
 * shipped twice before. Bounded at 5 attempts, then one final unconditional
 * write with a fully-random slug: registration must not be deniable by
 * anyone who can cheaply force collisions (D-107).
 *
 * Each attempt runs inside its own SAVEPOINT. Postgres aborts an entire
 * transaction the instant any statement inside it errors — catching the JS
 * exception from a failed `tx.organization.create()` does NOT undo that;
 * every later statement in the same `$transaction` callback (the retry, the
 * membership insert, the consent inserts) would fail with "current
 * transaction is aborted, commands ignored until end of transaction block"
 * even though the JS-level try/catch looks like it recovered. Confirmed live:
 * the brief's original snippet, with no SAVEPOINT, made the collision test
 * fail with exactly that Postgres error rather than a passing retry. A
 * SAVEPOINT before each attempt and a ROLLBACK TO on failure isolates the
 * failed INSERT from the rest of the transaction, so retries and the caller's
 * subsequent writes can proceed.
 */
async function createOrgInTx(
  tx: OwnerTx,
  orgName: string,
): Promise<{ id: string; slug: string }> {
  const base = deriveSlug(orgName) || 'org';
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
    const org = await tryCreateOrg(tx, orgName, slug);
    if (org !== null) return org;
  }
  // Fully-random 8-hex-char slug, astronomically unlikely to collide with
  // anything the 5 retries above already ruled out. Deliberately not routed
  // through `tryCreateOrg`: a repeat collision here is no longer "bad luck",
  // so it propagates straight out of the transaction uncaught rather than
  // being treated as retryable — silent-failure-hunter review confirmed an
  // earlier draft of this line accidentally re-submitted the SAME slug that
  // a preceding `tryCreateOrg` call had just proven collides, which could
  // never succeed; generating the slug once, here, for the one uncaught
  // attempt closes that.
  return tx.organization.create({
    data: { name: orgName, slug: `org-${randomBytes(4).toString('hex')}` },
    select: { id: true, slug: true },
  });
}

/**
 * One create attempt, wrapped in its own SAVEPOINT so a UNIQUE-violation
 * retry can proceed within the same outer transaction (see `createOrgInTx`
 * above). Returns `null` on a retryable collision; any other error
 * propagates unchanged.
 */
async function tryCreateOrg(
  tx: OwnerTx,
  orgName: string,
  slug: string,
): Promise<{ id: string; slug: string } | null> {
  await tx.$executeRawUnsafe('SAVEPOINT org_slug_attempt');
  try {
    const org = await tx.organization.create({
      data: { name: orgName, slug },
      select: { id: true, slug: true },
    });
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT org_slug_attempt');
    return org;
  } catch (e) {
    try {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT org_slug_attempt');
    } catch (rollbackError) {
      // The rollback itself failing (e.g. the connection dropped) is a more
      // serious condition than the original error and must not be
      // discarded in favour of it — surface both rather than letting one
      // silently replace the other in logs.
      throw new AggregateError([e, rollbackError], 'organization insert failed and its savepoint rollback also failed');
    }
    if (!isUniqueViolation(e)) throw e;
    return null;
  }
}

/**
 * True only for a UNIQUE violation on `organizations.slug` specifically.
 *
 * An earlier version of this function checked `e.meta.target`, on the theory
 * that Prisma reports the offending column(s) there. Verified live against
 * this stack (Prisma 7 + `@prisma/adapter-pg`, real `makrai_test` database)
 * that `meta.target` DOES NOT EXIST on a driver-adapter P2002 — the field
 * list instead lives at `meta.driverAdapterError.cause.constraint.fields`.
 * `pr-review-toolkit:code-reviewer` caught this independently by running the
 * same probe: the `target` check was unconditionally taking its "unknown
 * shape, assume collision" fallback on every single P2002, silently. Fixed
 * here to read the field list that is actually present on this stack. If the
 * `Organization` model ever gains a second unique column, a violation on
 * that column now correctly propagates instead of being swallowed as "try
 * another slug" for 5 retries before failing anyway.
 *
 * Still falls back to "treat as a slug collision" if the field list cannot
 * be found at all (mismatched Prisma/adapter version, wrapped error, etc.) —
 * that fallback matches this module's pre-existing behaviour and only
 * degrades to *originally* how the retry loop behaved, not to a new failure
 * mode.
 */
function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null || !('code' in e) || (e as { code: unknown }).code !== 'P2002') {
    return false;
  }
  const fields = uniqueViolationFields(e);
  return fields === null || fields.includes('slug');
}

type PrismaDriverAdapterErrorShape = {
  meta?: { driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } } };
};

function uniqueViolationFields(e: object): string[] | null {
  const fields = (e as PrismaDriverAdapterErrorShape).meta?.driverAdapterError?.cause?.constraint?.fields;
  return Array.isArray(fields) && fields.every((f) => typeof f === 'string') ? (fields as string[]) : null;
}
