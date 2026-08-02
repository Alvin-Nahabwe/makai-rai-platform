import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
    files: ['app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/lib/db', '@/lib/db'],
          message:
            'Routes must not use the unscoped Prisma client. Use withOrg() from lib/data/tenant, or identityDb from lib/data/identity for non-tenant models.',
        }],
      }],
    },
  },
]);

export default eslintConfig;
