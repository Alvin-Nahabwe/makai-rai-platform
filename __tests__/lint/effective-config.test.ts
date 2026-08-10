import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

/**
 * CRITICAL-1 (final Plan 1b whole-branch review, 2026-08-05).
 *
 * ESLint flat config REPLACES a rule's options per matching config object,
 * it does NOT merge them. Two `no-restricted-imports` blocks on
 * overlapping `files` globs — one banning `lib/db`/`auth`, a second banning
 * `createOrgContext`, added later — meant the second silently deleted the
 * first's patterns everywhere both applied, and `npm run lint` stayed 0
 * problems throughout because the deletion is a valid config, not a lint
 * error.
 *
 * Reading `eslint.config.mjs`'s SOURCE TEXT would not have caught this:
 * each block, read on its own, is correct. Only the RESOLVED config — what
 * `eslint --print-config` actually returns for a real file — reveals which
 * rule options survive to the file that matches both blocks. This suite
 * pins exactly that, machine-read from the live ESLint config resolution,
 * not transcribed from the source.
 *
 * Non-vacuity: reverting `eslint.config.mjs` to the pre-fix two-block form
 * (`git show <pre-fix-sha>:eslint.config.mjs`) makes every assertion below
 * fail — the resolved `patterns` array contains only the `createOrgContext`
 * group, so the `lib/db` and `auth` assertions find nothing. Verified by
 * hand while writing this fix, per `superpowers:test-driven-development`.
 *
 * Also covers the four PER-FILE OVERRIDE blocks (added by the same fix, to
 * restate the subset of bans that still apply to `lib/data/**`,
 * `lib/data/tenant.ts`, `lib/auth/identity.ts`, `lib/auth/context.ts`)
 * rather than only the general case — a simplify-pass finding: the
 * override bookkeeping is exactly where a future edit is most likely to
 * silently drop a ban for one of the sanctioned-exemption files, and a
 * suite that only pinned the general-case file would not catch that.
 */

type ImportPattern = {
  group?: string[];
  importNames?: string[];
  message?: string;
};

// Memoized per file: several `it` blocks below assert on the SAME
// resolved config for the SAME representative file, and `eslint
// --print-config` is a real subprocess spawn (Node + full flat-config
// resolution) — recomputing it per assertion is pure waste for a value
// that is deterministic within one test run. Efficiency-pass finding.
const rawConfigCache = new Map<string, { rules?: Record<string, unknown> }>();

function resolvedConfig(file: string): { rules?: Record<string, unknown> } {
  let cached = rawConfigCache.get(file);
  if (!cached) {
    const raw = execFileSync('npx', ['eslint', '--print-config', file], { encoding: 'utf8' });
    cached = JSON.parse(raw) as { rules?: Record<string, unknown> };
    rawConfigCache.set(file, cached);
  }
  return cached;
}

function effectiveNoRestrictedImportsPatterns(file: string): ImportPattern[] {
  const rule = resolvedConfig(file).rules?.['no-restricted-imports'];
  // ESLint's resolved rule entry is `[severity, options]`; `patterns` lives
  // on `options.patterns`. Anything else (rule absent, no `patterns`) means
  // the ban is not effectively wired for this file — every case below
  // should fail loudly rather than treat a missing array as "no patterns
  // to check", which is exactly how the original bug would have looked to
  // a vacuous assertion.
  if (!Array.isArray(rule) || rule.length < 2) {
    throw new Error(
      `no-restricted-imports is not configured as [severity, options] for ${file}: ${JSON.stringify(rule)}`,
    );
  }
  const options = rule[1] as { patterns?: ImportPattern[] };
  if (!Array.isArray(options.patterns)) {
    throw new Error(`no-restricted-imports has no patterns array for ${file}: ${JSON.stringify(options)}`);
  }
  return options.patterns;
}

function hasDbBan(patterns: ImportPattern[]): boolean {
  return patterns.some((p) => p.group?.includes('@/lib/db'));
}
function hasAuthBan(patterns: ImportPattern[]): boolean {
  return patterns.some((p) => p.group?.includes('@/lib/auth') && p.importNames?.includes('auth'));
}
function hasCreateOrgContextBan(patterns: ImportPattern[]): boolean {
  return patterns.some((p) => p.importNames?.includes('createOrgContext'));
}

describe('eslint effective config — the three import bans coexist (CRITICAL-1)', () => {
  // A representative ordinary `app/**` file — not one of the sanctioned
  // exemption files (lib/data/**, lib/auth/identity.ts, lib/auth/context.ts).
  const REPRESENTATIVE_FILE = 'app/(public)/login/page.tsx';

  it('carries the lib/db ban (D-074)', () => {
    const patterns = effectiveNoRestrictedImportsPatterns(REPRESENTATIVE_FILE);
    const dbBan = patterns.find((p) => p.group?.includes('@/lib/db'));
    expect(dbBan).toBeDefined();
    expect(dbBan?.message).toMatch(/withOrg/);
  });

  it('carries the auth ban (ADR-0002)', () => {
    const patterns = effectiveNoRestrictedImportsPatterns(REPRESENTATIVE_FILE);
    const authBan = patterns.find((p) => p.group?.includes('@/lib/auth') && p.importNames?.includes('auth'));
    expect(authBan).toBeDefined();
    expect(authBan?.message).toMatch(/requireIdentity/);
  });

  it('carries the createOrgContext ban (D-089) — the one that survived the collision', () => {
    const patterns = effectiveNoRestrictedImportsPatterns(REPRESENTATIVE_FILE);
    const orgCtxBan = patterns.find((p) => p.importNames?.includes('createOrgContext'));
    expect(orgCtxBan).toBeDefined();
  });

  it('all three bans are present simultaneously, not just individually', () => {
    const patterns = effectiveNoRestrictedImportsPatterns(REPRESENTATIVE_FILE);
    expect(patterns.length).toBeGreaterThanOrEqual(3);
  });

  it('a file that statically imports `auth` from `@/lib/auth` is actually flagged', () => {
    // The second, end-to-end verification: not just "is the pattern present
    // in the resolved config" but "does ESLint actually report an error
    // for the violation that pattern names". Runs against a throwaway
    // probe file rather than a fixture committed to the tree, so it never
    // itself becomes a permanent lint violator.
    const probePath = 'app/__effective_config_probe.ts';
    writeFileSync(probePath, "import { auth } from '@/lib/auth';\nexport const x = auth;\n");
    try {
      let exitCode = 0;
      try {
        execFileSync('npx', ['eslint', probePath], { encoding: 'utf8' });
      } catch (e) {
        exitCode = (e as { status?: number }).status ?? 1;
      }
      expect(exitCode).not.toBe(0);
    } finally {
      unlinkSync(probePath);
    }
  });
});

describe('eslint effective config — per-file override exemptions resolve as intended', () => {
  // Simplify-pass finding: the override bookkeeping (restating the ban
  // subset per sanctioned-exemption file) is where a future edit is most
  // likely to silently drop coverage. Pin the RESOLVED config for each of
  // the four override files, not just the general case.

  it('lib/data/connection.ts (representative of lib/data/**): exempt from db+auth bans, still carries createOrgContext ban', () => {
    const patterns = effectiveNoRestrictedImportsPatterns('lib/data/connection.ts');
    expect(hasDbBan(patterns)).toBe(false);
    expect(hasAuthBan(patterns)).toBe(false);
    expect(hasCreateOrgContextBan(patterns)).toBe(true);
  });

  it('lib/data/tenant.ts: exempt from no-restricted-imports entirely (definition site of createOrgContext)', () => {
    const rule = resolvedConfig('lib/data/tenant.ts').rules?.['no-restricted-imports'];
    // Resolved as `["off"]` (or severity 0) — NOT `[severity, options]` —
    // which is exactly why this file gets its own assertion rather than
    // reusing `effectiveNoRestrictedImportsPatterns` (that helper throws
    // on purpose for anything that isn't the `[severity, options]` shape).
    const severity = Array.isArray(rule) ? rule[0] : rule;
    expect(severity === 'off' || severity === 0).toBe(true);
  });

  it('lib/auth/identity.ts: exempt from the auth ban only (the sanctioned dynamic importer), still carries db+createOrgContext bans', () => {
    const patterns = effectiveNoRestrictedImportsPatterns('lib/auth/identity.ts');
    expect(hasDbBan(patterns)).toBe(true);
    expect(hasAuthBan(patterns)).toBe(false);
    expect(hasCreateOrgContextBan(patterns)).toBe(true);
  });

  it('lib/auth/context.ts: exempt from the createOrgContext ban only (the sanctioned caller), still carries db+auth bans', () => {
    const patterns = effectiveNoRestrictedImportsPatterns('lib/auth/context.ts');
    expect(hasDbBan(patterns)).toBe(true);
    expect(hasAuthBan(patterns)).toBe(true);
    expect(hasCreateOrgContextBan(patterns)).toBe(false);
  });

  /**
   * Plan 1c Task 1. `lib/data/framework.ts` is the module that reads the
   * `framework_versions` table, so it must stay inside the `lib/data/**`
   * exemption from the `lib/db` ban (Task 1 Step 1's pre-flight check,
   * confirmed live against `eslint --print-config` before the file was
   * created). Pinned here, separately from the `lib/data/connection.ts`
   * "representative of lib/data/**" case above, so a future ESLint config
   * edit that narrows the glob to exclude this specific file fails a test
   * instead of silently shipping a module that cannot read its own table.
   */
  it('lib/data/framework.ts: exempt from the db ban (it is inside the lib/data/** exemption)', () => {
    const patterns = effectiveNoRestrictedImportsPatterns('lib/data/framework.ts');
    expect(hasDbBan(patterns)).toBe(false);
  });
});
