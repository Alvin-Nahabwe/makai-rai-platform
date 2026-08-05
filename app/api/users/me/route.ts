import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { hash } from 'bcryptjs';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { membershipsForUser } from '@/lib/data/preauth';
import { scrubUserOnDeactivation } from '@/lib/data/identity';
import { logSecurityEvent } from '@/lib/security-logger';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Deactivate-and-scrub, not hard-delete. `identityDb` (lib/data/identity.ts)
 * deliberately exposes no `User.delete` — a delete would cascade into
 * tenant tables on the BYPASSRLS owner connection with no relation-tree
 * guard able to see it. Instead: refuse if the caller is the sole owner of
 * any organization (deleting them would leave that org ownerless forever),
 * drop every membership explicitly (one `withOrg` per org — RLS requires an
 * org-scoped GUC per delete, so this cannot be a single cross-org
 * statement), then scrub the identity row and delete consent records via
 * `scrubUserOnDeactivation`.
 *
 * TWO PHASES, not one, and each org's phase-2 step is a SINGLE transaction.
 * `pr-review-toolkit:silent-failure-hunter` (dispatched per AGENTS.md §2)
 * found the first draft checked the owner count and deleted the membership
 * in TWO SEPARATE `withOrg` transactions, an arbitrary amount of time
 * apart — a classic TOCTOU: a concurrent request against the same org
 * (this user racing themselves in two tabs, or an admin removing a
 * different owner at the same moment) could make the check stale before
 * the delete ran, leaving the org with zero owners.
 *
 *   PHASE 1 (read-only, all orgs): refuse up front if the caller is
 *   already the last owner of any org — cheap, and stops a doomed request
 *   before ANY org's membership is touched. This alone does not close the
 *   race (a concurrent write between phase 1 and phase 2 can still change
 *   the count), which is why phase 2 re-checks.
 *
 *   PHASE 2 (one transaction per org): `SELECT ... FOR UPDATE` locks every
 *   active-owner membership row in that org for the duration of the
 *   transaction, THEN re-counts, THEN deletes — all inside one `withOrg`
 *   call. A concurrent transaction touching the same org's owner rows
 *   blocks on the lock until this one commits or rolls back, so it always
 *   re-reads the post-commit count rather than acting on a stale one.
 *
 * RESIDUAL, not fully closable under this architecture: true cross-org
 * atomicity (if org B's phase-2 check fails, org A's phase-2 delete —
 * already committed — is not rolled back) is not available, because each
 * org's RLS scope is necessarily a separate transaction (ADR-0001). Phase 1
 * makes this residual narrow: it only bites if the SAME user's owner count
 * changes in a DIFFERENT org during the few milliseconds phase 2 takes to
 * walk the list, which requires a concurrent admin action landing in that
 * exact window. Tracked as D-119 rather than left implicit.
 */
export async function DELETE(request: NextRequest) {
  let identity;
  try {
    identity = await requireIdentityForApi();
  } catch (e) {
    return toResponse(e);
  }

  const body = await request.json();
  const { confirmation } = body;
  if (confirmation !== 'DELETE MY ACCOUNT') {
    return NextResponse.json({ error: 'Type "DELETE MY ACCOUNT" to confirm' }, { status: 400 });
  }

  // Cross-org by nature ("every org I belong to") — the same before-context
  // read `requireOrgContext` itself uses, not a tenant read (ADR-0001 §4).
  const memberships = await membershipsForUser(identity.userId);

  // PHASE 1 — read-only pre-check across every org the caller owns.
  for (const m of memberships) {
    if (m.role !== 'owner') continue;
    const ctx = await requireOrgContextFor(identity.userId, m.org.slug, 'org:read');
    const ownerCount = await withOrg(ctx, (tx) =>
      tx.membership.count({ where: { role: 'owner', status: 'active' } }),
    );
    if (ownerCount <= 1) {
      return NextResponse.json(
        {
          error: `You are the last owner of "${m.org.name}". Transfer ownership or delete the organization before deleting your account.`,
        },
        { status: 409 },
      );
    }
  }

  // PHASE 2 — one atomic check-and-delete transaction per org.
  for (const m of memberships) {
    const ctx = await requireOrgContextFor(identity.userId, m.org.slug, 'org:read');
    const blockedByOrgName = await withOrg(ctx, async (tx) => {
      if (m.role === 'owner') {
        // Locks every active-owner row in this org until this transaction
        // ends, so a concurrent racer sees this delete (or its own) applied
        // before it re-counts — see the module doc above.
        await tx.$queryRaw`SELECT id FROM memberships WHERE role = 'owner' AND status = 'active' FOR UPDATE`;
        const ownerCount = await tx.membership.count({ where: { role: 'owner', status: 'active' } });
        if (ownerCount <= 1) return m.org.name;
      }
      await tx.membership.deleteMany({ where: { userId: identity.userId } });
      return null;
    });

    if (blockedByOrgName) {
      logSecurityEvent('ACCOUNT_DEACTIVATED', 'error', {
        userId: identity.userId,
        details: { result: 'aborted_last_owner_race', orgName: blockedByOrgName },
      });
      return NextResponse.json(
        {
          error: `You became the last owner of "${blockedByOrgName}" during deletion. Please retry.`,
        },
        { status: 409 },
      );
    }
  }

  // A random, unusable password hash — the account can never be logged
  // into again (isActive is also set false, and sessionEpoch bumped, so
  // this is defence in depth, not the only barrier).
  const randomPasswordHash = await hash(randomBytes(32).toString('hex'), 12);
  await scrubUserOnDeactivation(identity.userId, randomPasswordHash);

  logSecurityEvent('ACCOUNT_DEACTIVATED', 'warn', {
    userId: identity.userId,
    details: { result: 'success', orgsLeft: memberships.length },
  });

  return NextResponse.json({ success: true, message: 'Account deactivated and personal data scrubbed.' });
}
