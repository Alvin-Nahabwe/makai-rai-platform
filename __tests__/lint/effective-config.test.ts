import { beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

type ResolvedConfig = { rules?: Record<string, unknown> };

// A representative ordinary `app/**` file — not one of the sanctioned
// exemption files (lib/data/**, lib/auth/identity.ts, lib/auth/context.ts).
const REPRESENTATIVE_FILE = 'app/(public)/login/page.tsx';

// Every file whose resolved config a case below reads.
const RESOLVED_FILES = [
  REPRESENTATIVE_FILE,
  'lib/data/connection.ts',
  'lib/data/tenant.ts',
  'lib/auth/identity.ts',
  'lib/auth/context.ts',
  'lib/data/framework.ts',
];

const resolvedConfigs = new Map<string, ResolvedConfig>();

// One ESLint instance resolves all of them, once, before any case runs.
// Loading the flat config is nearly all of the cost (the five files after
// the first take about 60 ms together), and each of these files used to pay
// it again in its own `npx eslint --print-config` subprocess: about 2 s per
// file with nothing else running, inside the first case to read that file.
// `eslint --print-config <file>` prints `JSON.stringify` of
// `calculateConfigForFile(<file>)` (lib/cli.js in the eslint package), on an
// ESLint that differs from this one only by an empty `rules` override, so
// the JSON round trip below leaves a case exactly what it parsed before.
//
// The limit is this hook's own: it waits for ESLint to import
// eslint.config.mjs and every plugin that file names. Measured at 1.4 s on
// a quiet 12-core machine, 2.0 s with six CPU-bound processes running and
// 4.6 to 5.8 s with 24.
beforeAll(async () => {
  const eslint = new ESLint();
  for (const file of RESOLVED_FILES) {
    const config: unknown = await eslint.calculateConfigForFile(file);
    resolvedConfigs.set(file, JSON.parse(JSON.stringify(config)) as ResolvedConfig);
  }
}, 30_000);

function resolvedConfig(file: string): ResolvedConfig {
  const cached = resolvedConfigs.get(file);
  // A missing entry must not read as "no rules": that is the vacuous pass
  // this suite exists to prevent.
  if (!cached) throw new Error(`${file} is not in RESOLVED_FILES, so its config was never resolved`);
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
    // The probe MUST live under app/ — that is the directory whose effective
    // config is under test, so a temp directory would prove nothing.
    //
    // It is therefore written where a killed run can strand it, and a stranded
    // probe is a deliberate lint violation sitting in the tracked tree: it
    // fails `npm run lint` for everyone until someone deletes it by hand. That
    // happened, and the audit recorded it as a red gate whose cause was not
    // the codebase (QG-1, T-09). Three defences, because `finally` alone was
    // the thing that proved insufficient:
    //   1. the name is unique per process, so concurrent runs cannot collide;
    //   2. any stale probe from an earlier crashed run is swept first, so the
    //      gate self-heals on the next test run instead of staying red;
    //   3. the glob is gitignored, so residue can never be committed.
    const probeDir = 'app';
    for (const stale of readdirSync(probeDir)) {
      if (stale.startsWith('__effective_config_probe')) {
        unlinkSync(join(probeDir, stale));
      }
    }

    const probePath = join(probeDir, `__effective_config_probe.${process.pid}.ts`);
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
      if (existsSync(probePath)) unlinkSync(probePath);
    }
    // Its own limit: the case waits for a whole `npx eslint` run on the probe,
    // a subprocess that starts npm, loads the flat config and lints one file.
    // That run is the check. Measured at 1.3 to 1.6 s on a quiet 12-core
    // machine, 1.9 to 6.4 s with six CPU-bound processes running beside other
    // work (load average 9 to 15) and 4.5 to 5.0 s with 24.
  }, 30_000);
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
