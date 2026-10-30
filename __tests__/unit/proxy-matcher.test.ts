import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { config } from '@/proxy';

// Loaded with require so Vite does not try to read Next's source maps.
const { getMiddlewareMatchers } = createRequire(__filename)('next/dist/build/analysis/get-page-static-info') as {
  getMiddlewareMatchers: (matcher: unknown, nextConfig: Record<string, unknown>) => Array<{ regexp: string }>;
};

/**
 * The proxy sets `x-pathname` on every page request (proxy.ts), and `requireIdentity()` decides two gates from it
 * (must-change-password lets only /change-password through; ACC-a's gate exempts /acceptances and /account). A path the
 * proxy does not run on reaches `requireIdentity()` with whatever header the client sent, so the matcher has to cover
 * every path except Next's own `_next/static` and `_next/image`, whatever the path ends in. It used to skip anything
 * ending in .png, .jpg, .jpeg, .svg, .ico or .webp, and a client sending `x-pathname: /change-password` on
 * `/does-not-exist.png` walked past the gate.
 *
 * Compiled the way Next compiles it (getMiddlewareMatchers, the function `next build` calls), then tested against the
 * pathname, which is what Next tests (the query string is not part of it).
 */
const runsOn = (pathname: string): boolean =>
  getMiddlewareMatchers(config.matcher, {}).some((m) => new RegExp(m.regexp).test(pathname));

describe('proxy.ts config.matcher', () => {
  it('NFR-SEC-02: runs on every page path, including those that end in an image extension', () => {
    for (const path of ['/', '/orgs/acme/projects/x', '/login', '/x.png', '/x.jpg', '/x.jpeg', '/x.svg', '/favicon.ico', '/a/b.webp', '/does-not-exist.png', '/change-password.svg']) {
      expect(runsOn(path), path).toBe(true);
    }
  });

  it('NFR-SEC-02: still runs on the API, and not on Next\'s own static and image paths', () => {
    expect(runsOn('/api/v1/x')).toBe(true);
    expect(runsOn('/api/users/me/password')).toBe(true);
    for (const path of ['/_next/static/chunks/a.js', '/_next/static/media/a.woff2', '/_next/image']) {
      expect(runsOn(path), path).toBe(false);
    }
  });

  it('NFR-SEC-02: nothing else is excluded: the matcher holds the API pattern and one pattern that names only the two Next paths', () => {
    expect(config.matcher).toEqual(['/api/:path*', '/((?!_next/static|_next/image).*)']);
  });
});
