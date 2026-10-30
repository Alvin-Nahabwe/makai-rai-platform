import { describe, it, expect } from 'vitest';
import {
  PENDING_LINK_TARGETS,
  assertNoStalePendingTargets,
  pendingTargetFor,
  stalePendingTargets,
  type PendingLinkTarget,
} from '@/e2e/helpers/pendingLinks';

/**
 * The shell links whose page another unit has not built yet (SRS 7.1.1 lists them; the sidebar links them from the day it
 * merges): e2e/no-score-crawl.spec.ts lets each answer exactly 404 and e2e/csp.spec.ts aborts a background request to each.
 * The list removes itself: the case below fails, naming the entry, as soon as its page file exists, so the producer deletes
 * the entry in the commit that adds its page.
 */

const SENTINEL: PendingLinkTarget[] = [
  { pattern: /^\/built$/, pageFile: 'package.json', producer: 'TEST-A' },
  { pattern: /^\/not-built$/, pageFile: 'no/such/page.tsx', producer: 'TEST-B' },
];

describe('pending shell link targets', () => {
  it('FR-RM-01 UX-37 (shell links): no pending link target has its page yet, so each entry is deleted by the commit that adds its page', () => {
    expect(() => assertNoStalePendingTargets()).not.toThrow();
    expect(stalePendingTargets().map((t) => `${t.pattern} (${t.producer}): ${t.pageFile}`)).toEqual([]);
  });

  it('FR-RM-01 UX-37 (helper): an entry whose page file exists is reported, and the error names the entry and its producer', () => {
    expect(stalePendingTargets(SENTINEL).map((t) => t.producer)).toEqual(['TEST-A']);
    expect(() => assertNoStalePendingTargets(SENTINEL)).toThrow(/PENDING_LINK_TARGETS entry .*built.* \(TEST-A\): package\.json exists now; delete the entry/);
    expect(() => assertNoStalePendingTargets([SENTINEL[1]])).not.toThrow();
    // exists is injectable, so the check does not depend on the disk
    expect(stalePendingTargets(SENTINEL, () => true)).toHaveLength(2);
    expect(stalePendingTargets(SENTINEL, () => false)).toEqual([]);
  });

  it('FR-RM-01 UX-37 (shell links): the list names the three sidebar targets, each with a page file under app/ and a producer', () => {
    expect(PENDING_LINK_TARGETS.map((t) => t.pageFile).sort()).toEqual([
      'app/(authenticated)/account/page.tsx',
      'app/(authenticated)/orgs/[slug]/settings/organisation/page.tsx',
      'app/(public)/about/page.tsx',
    ]);
    for (const t of PENDING_LINK_TARGETS) {
      expect(t.pageFile, String(t.pattern)).toMatch(/^app\/.*\/page\.tsx$/);
      expect(t.producer.length, String(t.pattern)).toBeGreaterThan(0);
    }
  });

  it('FR-RM-01 UX-37 (helper): a pathname matches its own entry only', () => {
    const entry = (pathname: string) => pendingTargetFor(pathname)?.producer;
    expect(entry('/orgs/acme/settings/organisation')).toBe('MEM (S-30)');
    expect(entry('/orgs/acme/settings/organisation/')).toBe('MEM (S-30)');
    expect(entry('/account')).toBe('ACC-b (S-21)');
    expect(entry('/about')).toBe('PUB (S-28)');
    for (const other of [
      '/orgs/acme/settings/members',
      '/orgs/acme/settings/organisation/extra',
      '/account/security',
      '/explore/about',
      '/about/team',
      '/orgs/acme/dashboard',
      '/',
    ]) {
      expect(entry(other), other).toBeUndefined();
    }
  });
});
