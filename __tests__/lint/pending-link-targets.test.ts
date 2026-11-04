import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
 * The list removes itself: the first case fails, naming the entry, as soon as its page file exists, so the producer deletes the
 * entry in the commit that adds its page.
 *
 * Nothing here pins the live list. A producer deletes its own entry without touching this file, and the list may end up empty:
 * the cases on the live list hold for every entry it has, and the matching is tested on a list built in the test.
 */

/** A synthetic list: one entry whose page file exists (package.json) and two whose page files do not. */
const SYNTHETIC: PendingLinkTarget[] = [
  { pattern: /^\/built$/, pageFile: 'package.json', producer: 'TEST-A' },
  { pattern: /^\/not-built\/?$/, pageFile: 'no/such/page.tsx', producer: 'TEST-B' },
  { pattern: /^\/orgs\/[^/]+\/settings\/thing\/?$/, pageFile: 'no/such/orgs/[slug]/settings/thing/page.tsx', producer: 'TEST-C' },
];

/** The URL pathname a page file serves: route groups are not part of it, and a dynamic segment is any one segment. */
function pathForPageFile(pageFile: string, segmentValue = 'x1'): string {
  const path = pageFile
    .replace(/^app\//, '')
    .replace(/\/?page\.tsx$/, '')
    .split('/')
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map((segment) => (/^\[.+\]$/.test(segment) ? segmentValue : segment))
    .join('/');
  return `/${path}`;
}

describe('pending shell link targets', () => {
  it('FR-RM-01 UX-37 (shell links): no pending link target has its page yet, so each entry is deleted by the commit that adds its page', () => {
    expect(() => assertNoStalePendingTargets()).not.toThrow();
    expect(stalePendingTargets().map((t) => `${t.pattern} (${t.producer}): ${t.pageFile}`)).toEqual([]);
  });

  it('FR-RM-01 UX-37 (shell links): every entry is well formed, with a pattern that matches the address its own page file serves and a producer', () => {
    for (const t of PENDING_LINK_TARGETS) {
      const id = `${t.pattern} (${t.producer})`;
      expect(t.pageFile, id).toMatch(/^app\/.*\/page\.tsx$/);
      expect(t.producer.trim().length, id).toBeGreaterThan(0);
      expect(t.pattern.test(pathForPageFile(t.pageFile)), `${id} must match ${pathForPageFile(t.pageFile)}, the address of ${t.pageFile}`).toBe(true);
    }
  });

  it('FR-RM-01 UX-37 (helper): an entry whose page file exists is reported, and the error names the entry and its producer', () => {
    expect(stalePendingTargets(SYNTHETIC).map((t) => t.producer)).toEqual(['TEST-A']);
    expect(() => assertNoStalePendingTargets(SYNTHETIC)).toThrow(/PENDING_LINK_TARGETS entry .*built.* \(TEST-A\): package\.json exists now; delete the entry/);
    expect(() => assertNoStalePendingTargets(SYNTHETIC.slice(1))).not.toThrow();
    expect(() => assertNoStalePendingTargets([])).not.toThrow();
    // exists is injectable, so the check does not depend on the disk
    expect(stalePendingTargets(SYNTHETIC, () => true)).toHaveLength(3);
    expect(stalePendingTargets(SYNTHETIC, () => false)).toEqual([]);
  });

  it('FR-RM-01 UX-37 (helper): a pathname matches its own entry only, on a list built here', () => {
    const entry = (pathname: string) => pendingTargetFor(pathname, SYNTHETIC)?.producer;
    expect(entry('/built')).toBe('TEST-A');
    expect(entry('/not-built')).toBe('TEST-B');
    expect(entry('/not-built/')).toBe('TEST-B');
    expect(entry('/orgs/acme/settings/thing')).toBe('TEST-C');
    for (const other of ['/built/more', '/not-built/more', '/orgs/acme/settings/other', '/orgs/acme/settings/thing/extra', '/explore/built', '/']) {
      expect(entry(other), other).toBeUndefined();
    }
    expect(pendingTargetFor('/anything', [])).toBeUndefined();
  });

  it('FR-RM-01 UX-37 (helper): the address of a page file is derived without its route groups and with any one segment for a dynamic one', () => {
    expect(pathForPageFile('app/(authenticated)/orgs/[slug]/settings/thing/page.tsx')).toBe('/orgs/x1/settings/thing');
    expect(pathForPageFile('app/(public)/about/page.tsx')).toBe('/about');
    expect(pathForPageFile('app/page.tsx')).toBe('/');
  });

  // The case below ends with the last entry of the list, and then has nothing to hold.
  it.skipIf(PENDING_LINK_TARGETS.length === 0)(
    'FR-RM-01 FR-RES-01 UX-37 (shell links): while a target is pending, every e2e spec that waits for networkidle aborts its background requests',
    () => {
      // A Link prefetch of an address that answers 404 never settles in a production build, so `networkidle` on a page with the shell
      // is never reached. A spec that waits for it without the abort would hang or time out on every signed-in page.
      const specs: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          if (statSync(path).isDirectory()) walk(path);
          else if (/\.spec\.ts$/.test(name)) specs.push(path);
        }
      };
      walk('e2e');
      expect(specs.length, 'the scan found no e2e spec').toBeGreaterThan(0);
      const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const waiting = specs.filter((f) => /networkidle/.test(strip(readFileSync(f, 'utf8'))));
      const without = waiting.filter((f) => !/\babort(PendingBackgroundRequests|IfPendingBackground)\b/.test(strip(readFileSync(f, 'utf8'))));
      expect(without, 'these specs wait for networkidle without aborting background requests to pending shell links (e2e/helpers/pendingLinks.ts)').toEqual([]);
    },
  );

  // At the release candidate (RELEASE_CANDIDATE=1, the content gate's own condition) no shell link may still answer 404: the
  // crawls and the CSP sweep let a pending target through, so this is the only thing that stops a dead link from shipping.
  it.runIf(process.env.RELEASE_CANDIDATE === '1')('FR-RM-01 UX-37 (release candidate): no shell link target is pending', () => {
    expect(PENDING_LINK_TARGETS.map((t) => `${t.producer}: ${t.pageFile}`)).toEqual([]);
  });
});
