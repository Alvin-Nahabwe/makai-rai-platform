import { afterEach, describe, expect, it } from 'vitest';
import { request as playwrightRequest } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  NonLoopbackRequestError,
  assertNodeSideRequestStaysLocal,
  installLoopbackGuard,
  isLoopbackHost,
  takeRefusals,
} from '../../e2e/helpers/loopbackGuard';

/**
 * No request from Playwright's Node side may leave the machine (FIX-2, V session 1's incident). An image config maps
 * makrai.org to the local nginx with Chromium's `--host-resolver-rules`, and only the browser honours that rule:
 * `route.fetch()`, `page.request`, the `request` fixture and any `request.newContext()` resolve makrai.org through DNS,
 * to the public site. All four reach the network through one method, `APIRequestContext._innerFetch`
 * (node_modules/playwright-core/lib/coreBundle.js, Route.fetch and APIRequestContext.fetch both call it), and the guard
 * of e2e/helpers/loopbackGuard.ts wraps it. Every spec an image config can run imports `test` from
 * e2e/helpers/loopbackOnly.ts, which installs the guard for its worker.
 */

const INVALID = 'https://guard.invalid/'; // RFC 6761: .invalid never resolves, so a guard that failed open sends nothing
const CLOSED = 'http://127.0.0.1:9/'; // the discard port, closed here: a request the guard lets through fails to connect

describe('the loopback policy', () => {
  afterEach(() => {
    takeRefusals();
  });

  it('NFR-SEC-17 FIX-2: loopback hosts are 127/8, localhost and ::1 only', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '[::1]']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['makrai.org', 'www.makrai.org', '172.67.167.139', '10.0.0.1', '0.0.0.0', 'guard.invalid', '127.0.0.1.nip.io', 'localhost.makrai.org', 'app.localhost']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });

  it('NFR-SEC-17 FIX-2: a Node-side request to a public host is refused and recorded', () => {
    expect(() => assertNodeSideRequestStaysLocal('https://makrai.org/api/v1/orgs/x/projects/y/decisions', { maxRedirects: 0, via: 't' })).toThrow(NonLoopbackRequestError);
    expect(takeRefusals()).toHaveLength(1);
    expect(takeRefusals()).toEqual([]);
  });

  it('NFR-SEC-17 FIX-2: a relative path is refused: its host is a baseURL this side cannot read', () => {
    expect(() => assertNodeSideRequestStaysLocal('/api/health', { maxRedirects: 0, via: 't' })).toThrow(/not an absolute URL/);
  });

  it('NFR-SEC-17 FIX-2: a loopback request must follow no redirect', () => {
    // The app answers with redirects to its public origin (NEXTAUTH_URL https://makrai.org); Node would follow one out.
    expect(() => assertNodeSideRequestStaysLocal('https://127.0.0.1:8460/api/health', { via: 't' })).toThrow(/maxRedirects: 0/);
    expect(() => assertNodeSideRequestStaysLocal('https://127.0.0.1:8460/api/health', { maxRedirects: 0, via: 't' })).not.toThrow();
    expect(() => assertNodeSideRequestStaysLocal('http://localhost:3102/api/health', { maxRedirects: 0, via: 't' })).not.toThrow();
  });
});

describe('the guard on Playwright and fetch', () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
    takeRefusals();
  });

  it('NFR-SEC-17 FIX-2: a request context refuses a public host and a relative path before it opens a connection', async () => {
    restore = await installLoopbackGuard(playwrightRequest);
    const ctx = await playwrightRequest.newContext({ baseURL: 'https://makrai.org' });
    try {
      await expect(ctx.get(INVALID, { maxRedirects: 0 })).rejects.toThrow(NonLoopbackRequestError);
      await expect(ctx.post(INVALID, { data: { a: 1 }, maxRedirects: 0 })).rejects.toThrow(NonLoopbackRequestError);
      await expect(ctx.get('/api/health', { maxRedirects: 0 })).rejects.toThrow(NonLoopbackRequestError);
      await expect(ctx.get(CLOSED)).rejects.toThrow(/maxRedirects: 0/);
      // Let through to loopback: it fails to connect, which is not the guard.
      const local = await ctx.get(CLOSED, { maxRedirects: 0, timeout: 5_000 }).then(() => 'answered', (e: Error) => e);
      expect(local).not.toBeInstanceOf(NonLoopbackRequestError);
      expect(takeRefusals()).toHaveLength(4);
    } finally {
      await ctx.dispose();
    }
  });

  it("NFR-SEC-17 FIX-2: Node's global fetch is guarded the same way, and restore puts everything back", async () => {
    const before = globalThis.fetch;
    const probe = await playwrightRequest.newContext();
    const proto = Object.getPrototypeOf(probe) as { _innerFetch: unknown };
    await probe.dispose();
    const innerBefore = proto._innerFetch;
    restore = await installLoopbackGuard(playwrightRequest);
    expect(proto._innerFetch).not.toBe(innerBefore);
    await expect(globalThis.fetch(INVALID, { redirect: 'manual' })).rejects.toThrow(NonLoopbackRequestError);
    await expect(globalThis.fetch(new Request(INVALID, { redirect: 'manual' }))).rejects.toThrow(NonLoopbackRequestError);
    await expect(globalThis.fetch(CLOSED)).rejects.toThrow(/maxRedirects: 0/);
    const local = await globalThis.fetch(CLOSED, { redirect: 'manual' }).then(() => 'answered', (e: Error) => e);
    expect(local).not.toBeInstanceOf(NonLoopbackRequestError);
    restore();
    restore = undefined;
    expect(globalThis.fetch).toBe(before);
    expect(proto._innerFetch).toBe(innerBefore);
  });
});

// ---------------------------------------------------------------------------------------------
// Which files an image config runs, generated from the configs, and that each uses the guard
// ---------------------------------------------------------------------------------------------

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** A config runs against an image when its browser reaches a public name: a baseURL off loopback, or a resolver rule. */
function imageConfigs(): { file: string; matchers: RegExp[] }[] {
  return readdirSync('.')
    .filter((f) => /^playwright.*\.config\.ts$/.test(f))
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => /--host-resolver-rules/.test(text) || [...text.matchAll(/baseURL:\s*'([^']+)'/g)].some((m) => !isLoopbackHost(new URL(m[1]).hostname)))
    .map(({ file, text }) => ({ file, matchers: [...text.matchAll(/testMatch:\s*\/((?:\\\/|[^/\n])+)\/([a-z]*)/g)].map((m) => new RegExp(m[1], m[2])) }));
}

function imageRunFiles(): string[] {
  const matchers = imageConfigs().flatMap((c) => c.matchers);
  // V's image config lives outside the repository and names its setup by the suffix `.image.ts`.
  return walk('e2e').filter((f) => /\.ts$/.test(f) && (matchers.some((r) => r.test(f)) || /\.image\.ts$/.test(f)));
}

describe('specs an image config runs use only the guarded path', () => {
  it('NFR-SEC-17 FIX-2: the image configs and their files are found (the check is not vacuous)', () => {
    expect(imageConfigs().map((c) => c.file)).toContain('playwright.perf-nginx.config.ts');
    const files = imageRunFiles();
    for (const f of ['e2e/first-visit-transfer.spec.ts', 'e2e/fixtures/content.setup.ts', 'e2e/fixtures/perf-signin.image.ts']) expect(files).toContain(f);
  });

  it.each(imageRunFiles().map((f) => [f]))('NFR-SEC-17 FIX-2: %s takes `test` from helpers/loopbackOnly and opens no Node-side channel of its own', (file) => {
    const src = readFileSync(file, 'utf8');
    // Every way of loading @playwright/test at run time other than a type-only named import is refused outright.
    expect(src, `${file} loads @playwright/test by require, import * or re-export`).not.toMatch(
      /require\(\s*['"]@playwright\/test['"]|import\s+\*\s+as\s+\w+\s+from\s+['"]@playwright\/test['"]|export\s+[^;]*from\s+['"]@playwright\/test['"]|import\(\s*['"]@playwright\/test['"]/,
    );
    const imports = [...src.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gm)].map((m) => ({
      typeOnly: Boolean(m[1]),
      names: m[2].split(',').map((n) => n.trim()).filter(Boolean),
      from: m[3],
    }));
    const guarded = imports.find((i) => /(^|\/)helpers\/loopbackOnly$/.test(i.from));
    expect(guarded, `${file} must import test from helpers/loopbackOnly`).toBeDefined();
    expect(guarded!.names.some((n) => /^test(\s+as\s+\w+)?$/.test(n))).toBe(true);
    const fromPlaywright = imports.filter((i) => i.from === '@playwright/test' && !i.typeOnly).flatMap((i) => i.names);
    const runtime = fromPlaywright.filter((n) => !/^type\s/.test(n)).map((n) => n.split(/\s+as\s+/)[0]);
    expect(runtime.filter((n) => n === 'test' || n === 'request'), `${file} takes test or request from @playwright/test`).toEqual([]);
    expect(src, `${file} imports a Node network module`).not.toMatch(/['"](node:)?(http|https|http2|net|tls|undici|ws)['"]/);
    expect(src, `${file} opens a WebSocket from Node`).not.toMatch(/new\s+WebSocket\b/);
  });
});
