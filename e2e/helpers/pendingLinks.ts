import fs from 'node:fs';
import type { BrowserContext, Page, Route } from '@playwright/test';

/**
 * Shell links (the sidebar, the footer, the public header) whose page another unit has not built yet, so the link answers 404
 * until that unit merges. The shell is built before them (SRS 7.1.1 lists the items), and each producer deletes its entry in the
 * commit that adds its page: the check below fails, naming the entry, as soon as `pageFile` exists, so nothing here outlives the
 * page it stands for.
 *
 * Two specs use the list, and neither changes the product:
 *   - e2e/no-score-crawl.spec.ts follows every link from `/` and fails on a status of 400 or more; a link to a pending target must
 *     answer exactly 404 (a page that was built answers something else and its entry is stale).
 *   - e2e/csp.spec.ts aborts a background request (a Link prefetch) to a pending target. In a production build Next 16.4.2 never
 *     settles a prefetch of an address that answers 404, which keeps `networkidle` from ever being reached on every signed-in page
 *     that links it.
 *
 * `pattern` matches the URL pathname, with ids and slugs as they appear in a real address.
 */
export type PendingLinkTarget = { pattern: RegExp; pageFile: string; producer: string };

export const PENDING_LINK_TARGETS: PendingLinkTarget[] = [
  // Linked from S-16 and S-17 (REV-b) before their pages exist (C4 RE-2): each producer deletes its entry when it adds the page.
  { pattern: /^\/orgs\/[^/]+\/projects\/[^/]+\/stages\/[^/]+\/?$/, pageFile: 'app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/page.tsx', producer: 'DEC-b (S-11)' },
  { pattern: /^\/orgs\/[^/]+\/projects\/[^/]+\/reviews\/[^/]+\/documents\/?$/, pageFile: 'app/(authenticated)/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/page.tsx', producer: 'DOC-a (S-18)' },
];

/** The entry for this URL pathname, or undefined. */
export function pendingTargetFor(pathname: string, targets: readonly PendingLinkTarget[] = PENDING_LINK_TARGETS): PendingLinkTarget | undefined {
  return targets.find((t) => t.pattern.test(pathname));
}

/** The entries whose page file exists now: each is stale and its producer deletes it. `exists` is injectable for the self-test. */
export function stalePendingTargets(
  targets: readonly PendingLinkTarget[] = PENDING_LINK_TARGETS,
  exists: (file: string) => boolean = fs.existsSync,
): PendingLinkTarget[] {
  return targets.filter((t) => exists(t.pageFile));
}

/** Throws, naming every stale entry, so a spec that relies on the list cannot pass over a page that now exists. */
export function assertNoStalePendingTargets(targets: readonly PendingLinkTarget[] = PENDING_LINK_TARGETS): void {
  const stale = stalePendingTargets(targets);
  if (stale.length > 0) {
    throw new Error(
      stale
        .map((t) => `PENDING_LINK_TARGETS entry ${t.pattern} (${t.producer}): ${t.pageFile} exists now; delete the entry in e2e/helpers/pendingLinks.ts`)
        .join('\n'),
    );
  }
}

/**
 * Aborts `route` if it is a background request (not a navigation) to a pending target, and says which entry it was; otherwise it
 * leaves the route alone and returns undefined. A Link prefetch is never a navigation, and a navigation to a pending page is
 * never aborted, so the 404 a person would see is still checked.
 */
export async function abortIfPendingBackground(route: Route, targets: readonly PendingLinkTarget[] = PENDING_LINK_TARGETS): Promise<PendingLinkTarget | undefined> {
  const request = route.request();
  if (request.isNavigationRequest()) return undefined;
  const target = pendingTargetFor(new URL(request.url()).pathname, targets);
  if (!target) return undefined;
  await route.abort();
  return target;
}

/** Installs `abortIfPendingBackground` on a context or a page; every other request goes on to the next handler. */
export async function abortPendingBackgroundRequests(
  scope: Pick<BrowserContext | Page, 'route'>,
  onAbort: (target: PendingLinkTarget) => void = () => {},
  targets: readonly PendingLinkTarget[] = PENDING_LINK_TARGETS,
): Promise<void> {
  await scope.route('**/*', async (route) => {
    const target = await abortIfPendingBackground(route, targets);
    if (target) onAbort(target);
    else await route.fallback();
  });
}
