import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ---------------------------------------------------------------------------
// CRITICAL-1 (final Plan 1b whole-branch review, fixed 2026-08-05).
//
// ESLint flat config REPLACES a rule's options per matching config object —
// it does NOT merge them across objects. Two `no-restricted-imports` blocks
// on overlapping `files` globs used to exist here: one banning `@/lib/db`
// (D-074) and `auth` (ADR-0002), a second banning `createOrgContext`
// (D-089), added later. Because both set the SAME rule name on overlapping
// globs, the second silently deleted the first's patterns for every file
// both applied to — verified two ways: `npx eslint --print-config` on a
// representative `app/**` file returned `no-restricted-imports` containing
// ONLY the `createOrgContext` pattern, and a probe file importing `auth`
// from `@/lib/auth` linted with exit 0. `no-restricted-syntax` (the dynamic
// `import()`/`require()` guard below) is a DIFFERENT rule name, so it never
// collided and stayed live throughout — which is why only the STATIC-import
// form of the ban was silently defeated.
//
// The fix: there is now exactly ONE config object below that sets
// `no-restricted-imports` for the general `app/**|lib/**` case, carrying
// all three pattern groups at once. Per-file exemptions are handled by
// dedicated, MORE SPECIFIC `files` overrides that each RESTATE the full
// set of groups that still apply to that file, rather than an object-level
// `ignores` — an `ignores` exempts a file from every group in the object's
// rule at once, which would be exactly this bug's shape one level down: a
// file that only needs exemption from ONE group would silently lose
// coverage for the other two. `__tests__/lint/effective-config.test.ts`
// pins the RESOLVED config (via `eslint --print-config`), not this source
// file's text — reading the source would not have caught the original bug,
// since the source of each individual block was, and reads as, correct.
// ---------------------------------------------------------------------------

const dbBanPattern = {
  // `patterns`, not `paths`. `paths` matches the literal specifier only, so
  // `../../lib/db` and `./db` walk straight through it — which is how
  // lib/auth.ts and lib/authz.ts evaded the first draft of this rule.
  // `**/db` is load-bearing and NOT redundant with `**/lib/db`. Verified
  // 2026-08-03: with only the four narrower patterns, a file two or more
  // levels inside lib/ — e.g. lib/authz/sub/x.ts importing '../../db' —
  // reaches lib/db.ts while matching none of them, defeating the ban for
  // exactly the class of file it exists to police.
  group: ['@/lib/db', '**/lib/db', '**/db', './db', '../db'],
  message:
    'Tenant data goes through withOrg (lib/data/tenant.ts); non-tenant through identityDb (lib/data/identity.ts). See ADR-0001.',
};

const authBanPattern = {
  // ADR-0002: the raw session is unreachable from application code.
  // `requireIdentity()`/`requireIdentityForApi()`/`tryResolveIdentity()`
  // (lib/auth/identity.ts) are the choke points — each re-checks
  // isActive/sessionEpoch/absolute-age against the database on every call,
  // which a cached `session.user.role` never did. `lib/auth/identity.ts`
  // itself is the one sanctioned place this import is allowed (see its
  // override below).
  group: ['@/lib/auth', '**/lib/auth', './auth', '../auth'],
  importNames: ['auth'],
  message: 'Use requireIdentity() from lib/auth/identity.ts. See ADR-0002.',
};

const createOrgContextBanPattern = {
  // D-089 / Task 5: `createOrgContext` mints an `OrgContext`, and an
  // `OrgContext` is only trustworthy when it was minted by
  // `requireOrgContext` — the one place that has proven the six facts
  // ADR-0001 requires before calling it.
  group: [
    '@/lib/data/tenant',
    '**/lib/data/tenant',
    '**/data/tenant',
    './tenant',
    '../tenant',
    '../data/tenant',
  ],
  importNames: ['createOrgContext'],
  message:
    'createOrgContext may only be called by requireOrgContext (lib/auth/context.ts). See lib/data/tenant.ts and ADR-0001 (D-089).',
};

const ALL_IMPORT_BAN_PATTERNS = [dbBanPattern, authBanPattern, createOrgContextBanPattern];

// Every per-file override below EXCLUDES from this array, rather than
// hand-listing the subset that still applies. Simplify-pass finding: a
// hand-listed subset silently goes stale if a fourth ban pattern is ever
// added to `ALL_IMPORT_BAN_PATTERNS` — exactly the "closed the instances,
// left the class open" shape this whole file's rewrite exists to eliminate,
// recurring one layer down. `.filter()` keeps every override automatically
// current with anything future added to the shared list, unless that
// override explicitly opts a file out of it here.
const patternsExcept = (...excluded) =>
  ALL_IMPORT_BAN_PATTERNS.filter((p) => !excluded.includes(p));

// `no-restricted-imports` only sees STATIC import declarations. `await
// import('../db')` and `require('../../lib/db')` both walk through it
// untouched, so the same two selectors are needed per banned module name.
// This rule name never collided with the bug above — kept exactly as it
// was, applied to the same general glob/ignore set as the `lib/db`+`auth`
// exemptions (files that may statically import `lib/db`/`auth` may also
// dynamically `import()`/`require()` them).
const dbSyntaxRules = [
  {
    selector: 'ImportExpression[source.value=/(^|\\u002F)db$/]',
    message:
      'Tenant data goes through withOrg (lib/data/tenant.ts); non-tenant through identityDb. See ADR-0001.',
  },
  {
    selector: "CallExpression[callee.name='require'][arguments.0.value=/(^|\\u002F)db$/]",
    message:
      'Tenant data goes through withOrg (lib/data/tenant.ts); non-tenant through identityDb. See ADR-0001.',
  },
];

const authSyntaxRules = [
  {
    selector: 'ImportExpression[source.value=/(^|\\u002F)auth$/]',
    message: 'Use requireIdentity() from lib/auth/identity.ts. See ADR-0002.',
  },
  {
    selector: "CallExpression[callee.name='require'][arguments.0.value=/(^|\\u002F)auth$/]",
    message: 'Use requireIdentity() from lib/auth/identity.ts. See ADR-0002.',
  },
];

const restrictedSyntaxRules = [...dbSyntaxRules, ...authSyntaxRules];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Scratch directory of the `remember` plugin, gitignored via
    // .remember/.gitignore. ESLint 9's flat config does not read .gitignore, so
    // without this it lints a throwaway file and `npm run lint` never reaches a
    // clean 0 problems — which trains people to ignore the output.
    ".remember/**",
    // Playwright run artifacts, regenerated by the e2e suite.
    "test-results/**",
    "playwright-report/**",
  ]),
  {
    rules: {
      // Allow intentionally-unused args/vars prefixed with `_`, and the common
      // `const { secret, ...rest } = obj` pattern for omitting a field.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Node-based test files legitimately use require() for module-reset patterns.
    files: ["__tests__/**", "**/*.test.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // THE GENERAL CASE: every three groups apply. This is the ONLY config
    // object in this file that sets `no-restricted-imports` for the broad
    // `app/**|lib/**` glob — every exemption below is a MORE SPECIFIC
    // `files` match that restates the subset of groups still needed,
    // rather than deleting or partially overriding this one.
    files: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ALL_IMPORT_BAN_PATTERNS }],
      'no-restricted-syntax': ['error', ...restrictedSyntaxRules],
    },
  },
  {
    // `lib/data/**` (except `lib/data/tenant.ts`, handled on its own below)
    // is the tenant/identity boundary layer: it DEFINES `withOrg`/
    // `identityDb`/etc. and legitimately imports `lib/db` and `auth`
    // directly. It may NOT import `createOrgContext` — that stays banned.
    files: ['lib/data/**/*.{ts,tsx}'],
    ignores: ['lib/data/tenant.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: patternsExcept(dbBanPattern, authBanPattern) }],
    },
  },
  {
    // `lib/data/tenant.ts` is the definition site of BOTH `createOrgContext`
    // (D-089) and, transitively, the tenant boundary `lib/db`/`auth` bans
    // exist to protect — exempt from all three here, same as before the
    // merge.
    files: ['lib/data/tenant.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // `lib/auth/identity.ts` is the ONE sanctioned place that may import
    // `auth` (ADR-0002) — via `resolveFromSession`'s DYNAMIC `import('../auth')`
    // (see that function's own comment for why it must be dynamic, not
    // static). That is what the `no-restricted-syntax` override below
    // exempts. Still may NOT import `lib/db` directly, statically or
    // dynamically, or `createOrgContext`.
    files: ['lib/auth/identity.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: patternsExcept(authBanPattern) }],
      'no-restricted-syntax': ['error', ...dbSyntaxRules],
    },
  },
  {
    // `lib/auth/context.ts` is the ONE sanctioned caller of
    // `createOrgContext` (`requireOrgContext`, D-089) — exempt from that
    // ban only. It imports neither `lib/db` nor `auth` today and stays
    // subject to both bans so a future addition of either is still caught.
    files: ['lib/auth/context.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: patternsExcept(createOrgContextBanPattern) }],
    },
  },
]);

export default eslintConfig;
