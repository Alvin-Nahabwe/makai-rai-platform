import { afterEach, describe, expect, it } from 'vitest';
import { request as playwrightRequest } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

type ImageConfig = { file: string; testDir: string; matchers: RegExp[]; matchAll: boolean };

/**
 * A config runs against an image when its browser reaches a public name: a baseURL off loopback (any quoting, and a
 * template counts as off loopback because it cannot be read), or a resolver rule. Its `matchAll` says it can run any
 * spec of its testDir: a project whose `testMatch` is not a regex literal (a string, a glob, an array) or that has none,
 * with none at the config's top level either. Such a config fails closed to every spec, not to none (SFH-5).
 */
export function parseImageConfig(file: string, text: string): ImageConfig | null {
  const baseUrls = [...text.matchAll(/baseURL:\s*(['"`])((?:(?!\1).)*)\1/g)].map((m) => m[2]);
  const image = /--host-resolver-rules/.test(text) || baseUrls.some((u) => /\$\{/.test(u) || !isLoopbackHost(new URL(u).hostname));
  if (!image) return null;
  const testDir = /testDir:\s*(['"`])\.?\/?((?:(?!\1).)*)\1/.exec(text)?.[2] ?? 'e2e';
  const { top, projects } = splitProjects(text);
  const topMatch = testMatchesOf(top);
  const matchers: RegExp[] = [...topMatch.matchers];
  let matchAll = topMatch.other;
  const own = projects.map(testMatchesOf);
  for (const m of own) {
    matchers.push(...m.matchers);
    if (m.other) matchAll = true;
    // A project with no testMatch of its own inherits the top-level one; with none there either, it runs everything.
    if (m.matchers.length === 0 && !m.other && topMatch.matchers.length === 0 && !topMatch.other) matchAll = true;
  }
  if (projects.length === 0 && topMatch.matchers.length === 0 && !topMatch.other) matchAll = true;
  return { file, testDir, matchers, matchAll };
}

/** The `testMatch:` values in `text`: regex literals as matchers, anything else as `other`. */
function testMatchesOf(text: string): { matchers: RegExp[]; other: boolean } {
  const matchers: RegExp[] = [];
  let other = false;
  for (const m of text.matchAll(/testMatch:\s*/g)) {
    const rest = text.slice(m.index + m[0].length);
    const literal = /^\/((?:\\\/|[^/\n])+)\/([a-z]*)/.exec(rest);
    if (literal) matchers.push(new RegExp(literal[1], literal[2]));
    else other = true;
  }
  return { matchers, other };
}

/** The config text without its `projects: [...]` array, and the text of each object in that array. */
function splitProjects(text: string): { top: string; projects: string[] } {
  const start = text.search(/projects:\s*\[/);
  if (start < 0) return { top: text, projects: [] };
  const open = text.indexOf('[', start);
  const projects: string[] = [];
  let depth = 0;
  let objStart = -1;
  let end = text.length;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '[' || c === '{' || c === '(') {
      depth++;
      if (c === '{' && depth === 2) objStart = i;
    } else if (c === ']' || c === '}' || c === ')') {
      if (c === '}' && depth === 2 && objStart >= 0) { projects.push(text.slice(objStart, i + 1)); objStart = -1; }
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  return { top: text.slice(0, start) + text.slice(end), projects };
}

/** The files of `all` that an image config can run. */
export function filesRunBy(cfg: ImageConfig, all: readonly string[]): string[] {
  return all.filter((f) => /\.ts$/.test(f) && f.startsWith(`${cfg.testDir}/`) && (cfg.matchAll || cfg.matchers.some((r) => r.test(f))));
}

function imageConfigs(): ImageConfig[] {
  return readdirSync('.')
    .filter((f) => /^playwright.*\.config\.ts$/.test(f))
    .map((file) => parseImageConfig(file, readFileSync(file, 'utf8')))
    .filter((c): c is ImageConfig => c !== null);
}

function imageRunFiles(): string[] {
  const all = walk('e2e');
  const run = new Set(imageConfigs().flatMap((c) => filesRunBy(c, all)));
  // V's image config lives outside the repository and names its setup by the suffix `.image.ts`.
  return all.filter((f) => /\.ts$/.test(f) && (run.has(f) || /\.image\.ts$/.test(f)));
}

const NETWORK_MODULE = /['"](node:)?(http|https|http2|net|tls|undici|ws)['"]/;

/** The relative, non-type-only imports of `src`, resolved against `file`'s directory, that name a file in the repository. */
function relativeImports(file: string, src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    if (m[1]) continue;
    const base = path.join(path.dirname(file), m[2]);
    for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) if (existsSync(c)) { out.push(c); break; }
  }
  return out;
}

/**
 * What is wrong with an image-run file's use of Playwright and Node networking; `readImported` returns a relative
 * import's source (one level deep only: the files it imports in turn are not read).
 */
export function guardProblems(file: string, src: string, readImported: (f: string) => string = (f) => readFileSync(f, 'utf8')): string[] {
  const problems: string[] = [];
  // Every way of loading @playwright/test at run time other than a type-only named import is refused outright.
  if (/require\(\s*['"]@playwright\/test['"]|import\s+\*\s+as\s+\w+\s+from\s+['"]@playwright\/test['"]|export\s+[^;]*from\s+['"]@playwright\/test['"]|import\(\s*['"]@playwright\/test['"]/.test(src)) {
    problems.push(`${file} loads @playwright/test by require, import * or re-export`);
  }
  if (/^import\s+(?!type\b)\w+\s*(,\s*\{[^}]*\})?\s+from\s+['"]@playwright\/test['"]/m.test(src)) {
    problems.push(`${file} default-imports @playwright/test, which is an unguarded test`);
  }
  const imports = [...src.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gm)].map((m) => ({
    typeOnly: Boolean(m[1]),
    names: m[2].split(',').map((n) => n.trim()).filter(Boolean),
    from: m[3],
  }));
  const guarded = imports.find((i) => /(^|\/)helpers\/loopbackOnly$/.test(i.from));
  if (!guarded || !guarded.names.some((n) => /^test(\s+as\s+\w+)?$/.test(n))) problems.push(`${file} must import test from helpers/loopbackOnly`);
  const fromPlaywright = imports.filter((i) => i.from === '@playwright/test' && !i.typeOnly).flatMap((i) => i.names);
  const runtime = fromPlaywright.filter((n) => !/^type\s/.test(n)).map((n) => n.split(/\s+as\s+/)[0]);
  if (runtime.some((n) => n === 'test' || n === 'request')) problems.push(`${file} takes test or request from @playwright/test`);
  if (NETWORK_MODULE.test(src)) problems.push(`${file} imports a Node network module`);
  if (/new\s+WebSocket\b/.test(src)) problems.push(`${file} opens a WebSocket from Node`);
  for (const imported of relativeImports(file, src)) {
    if (NETWORK_MODULE.test(readImported(imported))) problems.push(`${file} imports ${imported}, which imports a Node network module`);
  }
  return problems;
}

describe('specs an image config runs use only the guarded path', () => {
  it('NFR-SEC-17 FIX-2: the image configs and their files are found (the check is not vacuous)', () => {
    expect(imageConfigs().map((c) => c.file)).toContain('playwright.perf-nginx.config.ts');
    const files = imageRunFiles();
    for (const f of ['e2e/first-visit-transfer.spec.ts', 'e2e/fixtures/content.setup.ts', 'e2e/fixtures/perf-signin.image.ts']) expect(files).toContain(f);
  });

  it.each(imageRunFiles().map((f) => [f]))('NFR-SEC-17 FIX-2: %s takes `test` from helpers/loopbackOnly and opens no Node-side channel of its own', (file) => {
    expect(guardProblems(file, readFileSync(file, 'utf8'))).toEqual([]);
  });
});

describe('the lint of image-run files fails closed', () => {
  const ALL = ['e2e/a.spec.ts', 'e2e/sub/b.spec.ts', 'e2e/helpers/c.ts', 'other/d.spec.ts'];
  const wrap = (body: string) => `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './e2e', use: { baseURL: 'https://makrai.org' }, ${body} });`;

  it('NFR-SEC-17 SFH-5: a regex testMatch limits an image config to the files it matches', () => {
    const cfg = parseImageConfig('c.ts', wrap(`projects: [{ name: 'p', testMatch: /a\\.spec\\.ts$/ }]`))!;
    expect(cfg.matchAll).toBe(false);
    expect(filesRunBy(cfg, ALL)).toEqual(['e2e/a.spec.ts']);
  });

  it('NFR-SEC-17 SFH-5: an image config whose testMatch is a string or glob counts as running every spec of its testDir', () => {
    for (const body of [`testMatch: '**/*.spec.ts'`, `projects: [{ name: 'p', testMatch: '**/*.spec.ts' }]`, `projects: [{ name: 'p', testMatch: ['a.spec.ts'] }]`]) {
      const cfg = parseImageConfig('c.ts', wrap(body))!;
      expect(filesRunBy(cfg, ALL), body).toEqual(['e2e/a.spec.ts', 'e2e/sub/b.spec.ts', 'e2e/helpers/c.ts']);
    }
  });

  it('NFR-SEC-17 SFH-5: an image config with no testMatch counts as running every spec of its testDir', () => {
    for (const body of ['', `projects: [{ name: 'p' }]`, `testMatch: /a\\.spec\\.ts$/, projects: [{ name: 'p' }, { name: 'q', testMatch: 'x' }]`]) {
      expect(filesRunBy(parseImageConfig('c.ts', wrap(body))!, ALL), body).toHaveLength(3);
    }
    // A project that inherits a top-level regex runs only what it matches.
    expect(filesRunBy(parseImageConfig('c.ts', wrap(`testMatch: /a\\.spec\\.ts$/, projects: [{ name: 'p' }]`))!, ALL)).toEqual(['e2e/a.spec.ts']);
  });

  it('NFR-SEC-17 SFH-5: a double-quoted or template baseURL is read, and an unreadable template counts as an image', () => {
    const q = (u: string) => `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ use: { baseURL: ${u} } });`;
    expect(parseImageConfig('c.ts', q(`"https://makrai.org"`))).not.toBeNull();
    expect(parseImageConfig('c.ts', q('`https://makrai.org`'))).not.toBeNull();
    expect(parseImageConfig('c.ts', q('`https://${process.env.HOST}`'))).not.toBeNull();
    expect(parseImageConfig('c.ts', q(`'http://127.0.0.1:3102'`))).toBeNull();
    expect(parseImageConfig('c.ts', q(`e2eBaseURL(process.env)`))).toBeNull();
  });

  it('NFR-SEC-17 RE-4: a default import of @playwright/test is refused', () => {
    const src = `import base from '@playwright/test';\nimport { test } from './helpers/loopbackOnly';\n`;
    expect(guardProblems('e2e/x.spec.ts', src, () => '').join('\n')).toMatch(/default-imports @playwright\/test/);
    expect(guardProblems('e2e/x.spec.ts', `import base, { expect } from '@playwright/test';\nimport { test } from './helpers/loopbackOnly';\n`, () => '').join('\n')).toMatch(/default-imports/);
    // A type-only default import and the guarded form are fine.
    expect(guardProblems('e2e/x.spec.ts', `import type Foo from '@playwright/test';\nimport { test } from './helpers/loopbackOnly';\n`, () => '')).toEqual([]);
  });

  it('NFR-SEC-17 RE-4: an image-run file whose relative import opens a Node network module is refused, one level deep', () => {
    // The imported file is a real one (relative imports resolve against the disk); its source is what the stub returns.
    const src = `import { test } from './helpers/loopbackOnly';\nimport { x } from '../e2e/helpers/loopbackGuard';\n`;
    const stub = (guardSource: string) => (f: string) => (f === 'e2e/helpers/loopbackGuard.ts' ? guardSource : 'export {}');
    expect(guardProblems('e2e/x.spec.ts', src, stub(`import http from 'node:http';`)).join('\n')).toMatch(
      /imports e2e\/helpers\/loopbackGuard\.ts, which imports a Node network module/,
    );
    expect(guardProblems('e2e/x.spec.ts', src, stub('export {}'))).toEqual([]);
    // A type-only import is not loaded at run time, so it is not read.
    expect(guardProblems('e2e/x.spec.ts', src.replace('import { x }', 'import type { x }'), stub(`import http from 'node:http';`))).toEqual([]);
  });
});

describe('loopbackOnly reports a refusal that no test took', () => {
  it('NFR-SEC-17 SFH-12: the worker fixture drains the leftover refusals after use(), restores, then throws if any were left', () => {
    // A refusal in an afterAll hook or worker teardown has no test to fail; only the worker fixture sees it. Playwright
    // runs worker-fixture teardown outside any spec, so the order is pinned in the source (e2e/loopback-guard.spec.ts
    // cannot observe its own worker's teardown).
    const src = readFileSync('e2e/helpers/loopbackOnly.ts', 'utf8');
    const worker = /loopbackGuard:\s*\[([\s\S]*?)\{\s*scope:\s*'worker'/.exec(src)?.[1] ?? '';
    const order = ['await use()', 'takeRefusals()', 'restore()', 'throw new Error('].map((t) => worker.indexOf(t));
    expect(order.every((i) => i >= 0), `worker fixture: ${JSON.stringify(order)}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
