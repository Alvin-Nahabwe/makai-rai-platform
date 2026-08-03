import {
  PrismaClient,
  type Membership,
  type Organization,
  type Invitation,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { hmrSingleton, requireDatabaseUrl } from './connection';

/**
 * The before-context reads — and ONLY these.
 *
 * Some reads must happen before any org context exists: resolving which orgs a
 * user belongs to at login, mapping a URL slug to an organization, and looking
 * up an invitation by token. These are inherently cross-org ("which orgs am I
 * in" cannot be org-scoped), so no RLS policy can serve them; they run on the
 * owner connection, which bypasses RLS.
 *
 * That bypass is deliberate (ADR-0001) and must stay small. Do not add a
 * function here without deciding it is genuinely a before-context read —
 * __tests__/integration/preauth-surface.test.ts pins this module's exports and
 * will fail if the surface grows. The pin does not constrain what the existing
 * bodies return, so widening one (an added `include:`) is on the reviewer.
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
