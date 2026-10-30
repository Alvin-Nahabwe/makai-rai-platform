import { identityLaneClient } from './identityClient';

/**
 * Identity-lane reads that are not "before context" reads, so they do not belong in the pinned
 * `lib/data/preauth.ts` (00-contract.md, module map). K0a: the reminder run's organisation list
 * and its run lock (SRS 6.6; FR-FUP-03; NFR-REL-08). ACC-b adds `lastActiveOwnerOf` here.
 */

/** The fixed advisory-lock key of the reminder run (contract Services, K0a). */
export const REMINDER_LOCK_KEY = 7106652;

/**
 * Every organisation that is not archived (`deletedAt` null), with the name and slug the
 * reminder emails E-04 and E-05 print and link (`/orgs/<slug>/dashboard`), ordered by id
 * (finding R2-09, gap G089). The identity lane sees every organisation through its
 * identity_lane policy; the rows read here carry no record content.
 */
export async function listOrganisationsForReminders(): Promise<Array<{ orgId: string; name: string; slug: string }>> {
  const rows = await identityLaneClient.organization.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, slug: true },
  });
  return rows
    .map((o) => ({ orgId: o.id, name: o.name, slug: o.slug }))
    .sort((a, b) => (a.orgId < b.orgId ? -1 : a.orgId > b.orgId ? 1 : 0));
}

/**
 * Runs `cb` only while no other reminder run holds the lock (SRS 6.6: "takes
 * pg_try_advisory_lock and exits 0 at once"; NFR-REL-08's two concurrent runs). One identity-lane
 * transaction, up to 15 minutes, holds `pg_try_advisory_xact_lock(REMINDER_LOCK_KEY)`; another
 * caller gets 'locked' at once instead of waiting. `cb` uses its own connections (the reminder
 * lane of lib/data/tenant.ts); the lock is released when this transaction commits.
 */
export async function withReminderRunLock<T>(cb: () => Promise<T>): Promise<T | 'locked'> {
  return identityLaneClient.$transaction(
    async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${REMINDER_LOCK_KEY}::bigint) AS locked`;
      if (!locked) return 'locked' as const;
      return cb();
    },
    { timeout: 15 * 60 * 1000, maxWait: 10_000 },
  );
}
