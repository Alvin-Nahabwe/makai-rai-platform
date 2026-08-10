import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone', // For Docker deployment
  /**
   * Without this, `lib/framework/bundleHash.ts`'s `computeBundleHash()` can
   * throw ENOENT in the deployed Docker image: `docker/Dockerfile:31-35`
   * copies only `.next/standalone` into the runner stage, never `data/`
   * directly, so only files Turbopack's tracer placed inside
   * `.next/standalone` exist at runtime. `computeBundleHash` reads its 4
   * files with all-string-literal `readFileSync(join(root, 'data/x.json'))`
   * calls (see that file's own comment for why -- an EARLIER, loop-based
   * form was not reliably traceable and is not what ships), which the
   * tracer resolves correctly on its own; this directive is kept as an
   * explicit, documented guarantee rather than relying solely on that
   * incidental (if currently correct) static-analysis behaviour. Verified
   * live by building and listing `.next/standalone/data/` -- see
   * node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md:80-96
   * for the option itself.
   */
  outputFileTracingIncludes: {
    '/*': ['data/**/*.json'],
  },
  /**
   * NOT effective against the `.env` leak documented in
   * `lib/framework/bundleHash.ts` -- kept only as a general defence against
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
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
