import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import nextConfig from '@/next.config';
import { config } from '@/proxy';

// Loaded with require so Vite does not try to read Next's source maps.
const { getMiddlewareMatchers } = createRequire(__filename)('next/dist/build/analysis/get-page-static-info') as {
  getMiddlewareMatchers: (matcher: unknown, nextConfig: Record<string, unknown>) => Array<{ regexp: string }>;
};

/**
 * UX-01 (7.1.2: the gates run on every page request; gate 2 is must-change-password). The proxy sets `x-pathname` on
 * every page request (proxy.ts), and `requireIdentity()` decides two gates from it (must-change-password lets only
 * /change-password through; ACC-a's gate exempts /acceptances and /account). A path the proxy does not run on reaches
 * `requireIdentity()` with whatever header the client sent, so the matcher has to cover every path except Next's own
 * `_next/static` and `_next/image`, whatever the path ends in. It used to skip anything ending in .png, .jpg, .jpeg,
 * .svg, .ico or .webp.
 *
 * The exploit path is one that a dynamic segment takes: `/orgs/<slug>/projects/missing.png` matches
 * `app/(authenticated)/orgs/[slug]/projects/[id]`, so `(authenticated)/layout.tsx` runs `requireIdentity()` before the
 * page answers not-found, and a flagged account that sent `x-pathname: /change-password` got the signed-in shell. A path
 * no route matches (`/does-not-exist.png`) gets the root not-found page, which has no identity gate. For `/api/*` the
 * proxy removes a client's `x-pathname` (proxy-x-pathname.test.ts).
 *
 * Compiled the way Next compiles it (getMiddlewareMatchers, the function `next build` calls) with the project's own
 * config, then tested against the pathname, which is what Next tests (the query string is not part of it).
 */
const ROOT = path.resolve(__dirname, '../..');
const runsOn = (pathname: string): boolean =>
  getMiddlewareMatchers(config.matcher, nextConfig as unknown as Record<string, unknown>).some((m) => new RegExp(m.regexp).test(pathname));

describe('proxy.ts config.matcher', () => {
  it('UX-01: runs on every page path, including those that end in an image extension', () => {
    for (const path of ['/', '/orgs/acme/projects/x', '/login', '/x.png', '/x.jpg', '/x.jpeg', '/x.svg', '/favicon.ico', '/a/b.webp', '/does-not-exist.png', '/change-password.svg']) {
      expect(runsOn(path), path).toBe(true);
    }
  });

  it('UX-01: still runs on the API, and not on Next\'s own static and image paths', () => {
    expect(runsOn('/api/v1/x')).toBe(true);
    expect(runsOn('/api/users/me/password')).toBe(true);
    for (const path of ['/_next/static/chunks/a.js', '/_next/static/media/a.woff2', '/_next/image']) {
      expect(runsOn(path), path).toBe(false);
    }
  });

  it('UX-01: nothing else is excluded: the matcher holds the API pattern and one pattern that names only the two Next paths', () => {
    expect(config.matcher).toEqual(['/api/:path*', '/((?!_next/static|_next/image).*)']);
  });
});

/**
 * The lookahead `(?!_next/static|_next/image)` excludes those two paths only while no route can take them as a value: a
 * root-level dynamic segment (`app/[x]`, `app/[...x]`, `app/[[...x]]`) would let `/_next/static/...` resolve to a page,
 * and that page would run without the proxy. A route group `(group)` and a parallel slot `@slot` are not URL segments, so
 * a dynamic segment directly inside one is still at the root.
 */
function rootDynamicSegments(appDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const here = path.posix.join(rel, entry.name);
      if (/^\(.+\)$/.test(entry.name) || entry.name.startsWith('@')) walk(path.join(dir, entry.name), here);
      else if (/^\[.+\]$/.test(entry.name)) found.push(here);
      // Any other name is a literal URL segment; what is inside it is not at the root.
    }
  };
  walk(appDir, '');
  return found;
}

describe('the root of app/ and the matcher\'s lookahead', () => {
  it('UX-01: the finder reports a root-level dynamic or catch-all segment, in a route group or a slot too, and nothing nested', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'app-tree-'));
    try {
      for (const dir of [
        '[x]', '[...y]', '[[...z]]', '(marketing)/[a]', '(g1)/(g2)/[[...b]]', '@modal/[c]',
        'orgs/[slug]', 'api/auth/[...nextauth]', '(authenticated)/orgs/[slug]/projects/[id]', 'plain',
      ]) mkdirSync(path.join(root, dir), { recursive: true });
      expect(rootDynamicSegments(root).sort()).toEqual(['(g1)/(g2)/[[...b]]', '(marketing)/[a]', '@modal/[c]', '[...y]', '[[...z]]', '[x]'].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('UX-01: app/ has no root-level dynamic or catch-all segment, so nothing can take /_next/static or /_next/image as a value', () => {
    expect(rootDynamicSegments(path.join(ROOT, 'app'))).toEqual([]);
  });
});
