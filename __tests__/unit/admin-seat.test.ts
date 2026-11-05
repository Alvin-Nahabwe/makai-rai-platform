import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { adminSeat, AUTH_DIR } from '../../e2e/fixtures/manifest';

/**
 * The platform administrator seat of the e2e setup (units/ORG.md Task 8b; R11-17, R11-31): one administrator per
 * e2e run, got or created by the setup, signed in through /login, and used by the no-score crawl, the
 * research-consent crawl and the CSP sweep instead of an administrator of their own.
 */
describe('the platform administrator seat', () => {
  it('FR-RM-01: adminSeat() names the platform administrator and a storage state file in the e2e auth directory', () => {
    expect(adminSeat()).toEqual({ label: 'platform administrator', storageStatePath: path.join(AUTH_DIR, 'platform-admin.json') });
    expect(path.dirname(adminSeat().storageStatePath)).toBe(AUTH_DIR);
  });

  it('FR-RM-01 NFR-SEC-19: the setup gets or creates the administrator, signs in through /login and records the seat in the manifest', () => {
    const src = readFileSync('e2e/fixtures/auth.setup.ts', 'utf8');
    expect(src).toMatch(/await getOrCreatePlatformAdmin\(/);
    expect(src).not.toMatch(/\bbuildPlatformAdmin\b/);                       // only the helper builds one
    expect(src).toContain("waitForURL('**/admin/organisations')");
    expect(src).toMatch(/storageState\(\{ path: adminSeat\(\)\.storageStatePath \}\)/);
    expect(src).toMatch(/platformAdmin:\s*adminSeat\(\)/);
    expect(src).not.toMatch(/import[^;]*\bresetDb\b|role:\s*'admin'/);   // the seat comes from the helper, never from a hand-written update
  });

  it('FR-RM-01: the no-score crawl visits the five role seats and the platform administrator', () => {
    const src = readFileSync('e2e/no-score-crawl.spec.ts', 'utf8');
    expect(src).toMatch(/\[\s*\.\.\.oneSeatPerRole\(\),\s*adminSeat\(\)\s*\]/);
    expect(src).toMatch(/import\s*\{[^}]*\badminSeat\b[^}]*\}\s*from\s*'\.\/fixtures\/manifest'/);
  });

  it('NFR-SEC-19: csp.spec.ts uses the seat and builds no administrator of its own', () => {
    const src = readFileSync('e2e/csp.spec.ts', 'utf8');
    expect(src).not.toMatch(/\bbuildPlatformAdmin\b/);
    expect(src).toMatch(/import\s*\{[^}]*\badminSeat\b[^}]*\}\s*from\s*'\.\/fixtures\/manifest'/);
    expect(src).toMatch(/storageState:\s*adminSeat\(\)\.storageStatePath/);
  });

  it('FR-RES-01 FR-ORG-03: the research-consent crawl has an administrator pass, so the administrator pages are crawled', () => {
    const src = readFileSync('e2e/no-research-consent.spec.ts', 'utf8');
    expect(src).toMatch(/adminSeat\(\)\.storageStatePath/);
    expect(src).toContain("'administrator'");
  });
});
