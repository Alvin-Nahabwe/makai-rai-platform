import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone', // For Docker deployment
  /**
   * Without this, code that reads `data/*.json` at runtime can throw ENOENT
   * in the deployed Docker image: `docker/Dockerfile:31-35` copies only
   * `.next/standalone` into the runner stage, never `data/` directly, so
   * only files Turbopack's tracer placed inside `.next/standalone` exist at
   * runtime. The 4.0.0 bundle hash that first needed this
   * (`lib/framework/bundleHash.ts`) was removed in 0.6.0; the directive is
   * kept as an explicit, documented guarantee for the content readers that
   * remain. Verified live by building and listing `.next/standalone/data/` -- see
   * node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md:80-96
   * for the option itself.
   *
   * `data/legal/**` holds the legal texts (`lib/legal/registry.ts`), read at
   * runtime by the acceptance gate, so the image must carry them; they are
   * Markdown, which the JSON glob does not reach.
   *
   * `lib/auth/passwordHashWorker.js` is started by path as a worker thread (`lib/auth/passwordHash.ts`), and it
   * `require`s bcryptjs at run time, so neither is reached by the import trace; the image needs both (FR-ACC-05).
   * `scripts/check-standalone.mjs` fails the build check when either is missing.
   *
   * `lib/documents/render/pdfWorker.mjs` is started the same way, by path, to render working reports off the main thread
   * (lib/documents/render/pdfWorkerPool.ts), and imports `./breakPoints.mjs` and `react/jsx-runtime` at run time; react-pdf
   * itself is a server external package the routes already trace. The check fails the build when any of them is missing.
   */
  outputFileTracingIncludes: {
    '/*': [
      'data/**/*.json', 'data/legal/**/*.md', 'data/fonts/**', 'lib/auth/passwordHashWorker.js', 'node_modules/bcryptjs/package.json', 'node_modules/bcryptjs/umd/**',
      'lib/documents/render/pdfWorker.mjs', 'lib/documents/render/breakPoints.mjs', 'node_modules/react/jsx-runtime.js', 'node_modules/react/cjs/react-jsx-runtime.production.js',
    ],
  },
  /**
   * NOT effective against the `.env` leak that the 4.0.0 bundle hash
   * (`lib/framework/bundleHash.ts`, removed in 0.6.0) once caused -- kept only as a general defence against
   * ordinary over-inclusion (a route accidentally pulling in an unrelated
   * file through the normal static trace-list path, which this DOES govern).
   * Verified live, twice, under two different `bundleHash.ts`
   * implementations, that this rule does nothing to stop the `.env` case.
   * The actual `.env` fix is TWO independent layers, neither redundant --
   * see `.dockerignore`'s header comment for why both stay: the root cause
   * (no `.dockerignore` existed, so `.env` entered the Docker build context
   * unconditionally via `docker/Dockerfile:18`'s `COPY . .`) and
   * `package.json`'s `postbuild` script (`rm -rf .next/standalone/.env*`,
   * a second, independent layer for routes this file cannot anticipate).
   * Register row D-149 (`docs/DEFERRED_REGISTER.md`) has the full
   * investigation, both rounds.
   */
  outputFileTracingExcludes: {
    '/*': ['.env*'],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  /**
   * No `headers()` here, on purpose: nginx (`docker/nginx/default.conf`) is the
   * single source of every security header, so each is sent once. A second copy
   * in this file would be served alongside nginx's and drift from it.
   * `__tests__/lint/security-headers.test.ts` fails if one reappears.
   * The one header Next adds by itself is the framework-name banner, off below.
   */
  poweredByHeader: false,
  /**
   * The About page moved from `/explore/about` (signed-in only) to `/about`
   * (public, S-28). The sidebar and bookmarks still point at the old address.
   * `redirects()` only; `headers()` stays out of this file on purpose, see above.
   */
  async redirects() {
    return [{ source: '/explore/about', destination: '/about', permanent: true }];
  },
};

export default nextConfig;
