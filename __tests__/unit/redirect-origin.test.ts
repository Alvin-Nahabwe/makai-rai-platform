import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { createRequire } from 'node:module';
import type * as TS from 'typescript';

/**
 * An absolute URL the server sends to a browser must be built from the configured public
 * origin (`lib/publicOrigin.ts`), never from the request.
 *
 * Behind nginx the request's host is not the public one. The standalone server builds
 * `request.url` from the address it binds to, which is `$HOSTNAME` (D-236): the container id
 * until `ENV HOSTNAME=0.0.0.0` went into the runner stage, `0.0.0.0` since. Measured on the
 * built server: an unauthenticated POST to /api/admin/users/x/role answered
 * `303 location: https://0.0.0.0:3000/login`. Neither host is reachable from a browser.
 *
 * The first describe drives the one route that did this, with the request URLs the server
 * really produces. The second is generated from the source tree, so a second route doing the
 * same fails here the day it is written (the first test would never have known it existed). It
 * parses the code and matches shapes, not names, and it has a test for every idiom that got
 * past its first, regular-expression version.
 */

const requireIdentityForApi = vi.fn();
const findUnique = vi.fn();
const update = vi.fn();
const adminSetAccountActive = vi.fn();
const accountHasMembership = vi.fn();

vi.mock('@/lib/auth/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/identity')>()),
  requireIdentityForApi: (...args: unknown[]) => requireIdentityForApi(...args),
}));
vi.mock('@/lib/data/identity', () => ({
  identityDb: { user: { findUnique: (...a: unknown[]) => findUnique(...a), update: (...a: unknown[]) => update(...a) } },
}));
vi.mock('@/lib/security-logger', () => ({ logSecurityEvent: vi.fn() }));
vi.mock('@/lib/data/definer', () => ({ adminSetAccountActive: (...a: unknown[]) => adminSetAccountActive(...a) }));
vi.mock('@/lib/data/admin', () => ({ accountHasMembership: (...a: unknown[]) => accountHasMembership(...a) }));

/** vitest.config.ts sets NEXTAUTH_URL; this is what publicOrigin() must produce. */
const PUBLIC = 'https://vitest.example.invalid';

/** What `request.url` holds on the server: the bind host, with nginx's X-Forwarded-Proto. */
const BIND_HOSTS = ['https://0.0.0.0:3000', 'http://1038b2a33d91:3000'];

const ADMIN = { userId: 'admin-1', platformRole: 'admin' };

function formPost(base: string, fields: Record<string, string>): NextRequest {
  return new NextRequest(`${base}/api/admin/users/target-1/role`, {
    method: 'POST',
    body: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
}

async function post(base: string, fields: Record<string, string> = { action: 'deactivate' }): Promise<Response> {
  const { POST } = await import('../../app/api/admin/users/[id]/role/route');
  return POST(formPost(base, fields), { params: Promise.resolve({ id: 'target-1' }) });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  requireIdentityForApi.mockReset();
  findUnique.mockReset();
  update.mockReset();
  adminSetAccountActive.mockReset();
  accountHasMembership.mockReset();
  requireIdentityForApi.mockResolvedValue(ADMIN);
  findUnique.mockResolvedValue({ id: 'target-1', role: 'assessor', isActive: true });
  update.mockResolvedValue({});
  adminSetAccountActive.mockResolvedValue({ affectedOrgIds: [] });
  accountHasMembership.mockResolvedValue(false);
});

describe('POST /api/admin/users/[id]/role redirects to the public origin', () => {
  it.each(BIND_HOSTS)('every redirect leaves a request whose URL says %s on the public origin', async (base) => {
    const { UnauthenticatedError } = await import('../../lib/auth/identity');

    // [label, arrange, fields, expected path]
    const cases: [string, () => void, Record<string, string>, string][] = [
      ['unauthenticated', () => requireIdentityForApi.mockRejectedValue(new UnauthenticatedError()), { action: 'deactivate' }, '/login'],
      ['not an admin', () => requireIdentityForApi.mockResolvedValue({ userId: 'u', platformRole: 'assessor' }), { action: 'deactivate' }, '/'],
      ['unknown target', () => findUnique.mockResolvedValue(null), { action: 'deactivate' }, '/admin/accounts'],
      ['own account', () => findUnique.mockResolvedValue({ id: ADMIN.userId, role: 'admin', isActive: true }), { action: 'deactivate' }, '/admin/accounts?error=self'],
      ['role changed', () => undefined, { role: 'assessor' }, '/admin/accounts'],
      ['second administrator refused', () => undefined, { role: 'admin' }, '/admin/accounts?error=single_admin'],
      ['deactivated', () => undefined, { action: 'deactivate' }, '/admin/accounts'],
    ];

    for (const [label, arrange, fields, path] of cases) {
      requireIdentityForApi.mockResolvedValue(ADMIN);
      findUnique.mockResolvedValue({ id: 'target-1', role: 'assessor', isActive: true });
      arrange();

      const res = await post(base, fields);

      expect(res.status, label).toBe(303);
      expect(res.headers.get('location'), label).toBe(`${PUBLIC}${path}`);
    }
  });

  it('names neither the bind address nor a container id in any Location', async () => {
    const res = await post('https://0.0.0.0:3000');
    const location = res.headers.get('location') ?? '';

    expect(location).not.toContain('0.0.0.0');
    expect(location).not.toMatch(/1038b2a33d91|:3000/);
  });

  // The success redirect is the last thing the route does. If its URL could only be worked out
  // then, a deployment missing NEXTAUTH_URL would commit the change and show the admin a 500.
  // publicOrigin() throws when it is unset, so the route has to ask for it before it touches
  // the database.
  it.each([
    ['a role change', { role: 'assessor' }],
    ['a deactivation', { action: 'deactivate' }],
  ])('writes nothing when NEXTAUTH_URL is missing: %s', async (_name, fields) => {
    vi.stubEnv('NEXTAUTH_URL', '');

    await expect(post('https://0.0.0.0:3000', fields)).rejects.toThrow(/NEXTAUTH_URL/);

    expect(update).not.toHaveBeenCalled();
    expect(adminSetAccountActive).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(requireIdentityForApi).not.toHaveBeenCalled();
  });
});

// Loaded with Node's own require: through vitest's transform the compiler logs a missing
// source-map error on every run, because typescript.js names a .map file its package omits.
const ts = createRequire(import.meta.url)('typescript') as typeof TS;

/**
 * What, in one file, reads the address a request arrived on. Parsed with the TypeScript
 * compiler rather than matched with regular expressions, so that comments and string contents
 * are not code (`app/api/v1/orgs/[slug]/members/route.ts` says "NOT req.nextUrl.origin" in a
 * comment, and that is the explanation this guard exists to keep) and so that no rule depends
 * on what a request variable happens to be called.
 *
 * One label per occurrence. The rules are about the shape of the code, not names:
 *  - any `.url` read: `request.url`, `r.url`, `nextRequest.url`, `ctx.request.url`;
 *  - `nextUrl` used for anything but its path (`.clone()`, `.origin`, passed on whole);
 *  - `url` or `nextUrl` destructured out of something;
 *  - a two-argument `new URL(path, base)` whose base is not `publicOrigin()`;
 *  - a Host or X-Forwarded-Host header read, each with its own label.
 */
const NEXT_URL_PATH_ONLY = new Set(['pathname', 'search', 'searchParams']);

const L = {
  url: 'a .url read (the address a request arrived on)',
  nextUrl: 'nextUrl used for more than pathname, search or searchParams',
  destructured: 'url or nextUrl destructured out of an object',
  base: 'new URL(path, base) with a base other than publicOrigin()',
  host: 'a Host header read',
  forwardedHost: 'an X-Forwarded-Host header read',
} as const;

function addressReads(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: string[] = [];

  const visit = (node: TS.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === 'url') hits.push(L.url);
      if (node.name.text === 'nextUrl') {
        const p = node.parent;
        const pathOnly =
          (ts.isPropertyAccessExpression(p) && p.expression === node && NEXT_URL_PATH_ONLY.has(p.name.text)) ||
          (ts.isVariableDeclaration(p) &&
            p.initializer === node &&
            ts.isObjectBindingPattern(p.name) &&
            p.name.elements.every((e) => NEXT_URL_PATH_ONLY.has((e.propertyName ?? e.name).getText(sf))));
        if (!pathOnly) hits.push(L.nextUrl);
      }
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = (node.propertyName ?? node.name).getText(sf);
      if (key === 'url' || key === 'nextUrl') hits.push(L.destructured);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
      const base = node.arguments?.[1];
      if (base) {
        const configured = ts.isCallExpression(base) && ts.isIdentifier(base.expression) && base.expression.text === 'publicOrigin' && base.arguments.length === 0;
        if (!configured && !ts.isStringLiteralLike(base)) hits.push(L.base);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'get' &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const header = node.arguments[0].text.toLowerCase();
      if (header === 'host') hits.push(L.host);
      if (header === 'x-forwarded-host') hits.push(L.forwardedHost);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/**
 * Allowed by count, per file and per label, so an exception cannot widen: a second Host read
 * in the same file, or an X-Forwarded-Host read there, is a new hit.
 *
 * - The shared CSRF check (`lib/http/sameOrigin.ts`) compares the Origin header's host with the
 *   Host header nginx forwards (`proxy_set_header Host $host`), which is the public name, and
 *   builds no URL. The role route's own copy of that check is gone: it calls the shared one.
 * - The content check (`lib/content/validate.ts`) reads a content record's link field, a control's
 *   resource `url`, not a request; it handles no request (scripts and tests only).
 * - The evidence modules read the address of a link evidence item (`body.url`, `a.url`, the stored link): data a
 *   member typed, which the platform stores and never requests (FR-EVD-03; __tests__/lint/evidence-never-fetches.test.ts
 *   holds that). The browser module's `a.url` is the path of its own upload endpoint, not a request URL.
 * - The session-read guard (`lib/auth/sessionEndpoint.ts`, ACC-b) reads only the pathname of the request's URL to decide
 *   whether it is `/api/auth/session`; it builds no URL and redirects nowhere. It takes a plain `Request`, which has no
 *   `nextUrl`.
 */
const ALLOWED: Record<string, Record<string, number>> = {
  'lib/http/sameOrigin.ts': { [L.host]: 1 },
  'lib/content/validate.ts': { [L.url]: 1 },
  'lib/evidence/link.ts': { [L.url]: 4 },
  'lib/data/evidence.ts': { [L.url]: 1 },
  'lib/client/evidenceUpload.ts': { [L.url]: 2 },
  'app/api/v1/orgs/[slug]/projects/[id]/evidence/route.ts': { [L.url]: 1 },
  'lib/auth/sessionEndpoint.ts': { [L.url]: 1 },
};

/** The labels in `file` that its allowance does not cover. */
function scan(file: string, src: string): string[] {
  const counts = new Map<string, number>();
  for (const label of addressReads(file, src)) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].filter(([label, n]) => n > (ALLOWED[file]?.[label] ?? 0)).map(([label]) => label);
}

describe('no server file builds an absolute URL from the request', () => {
  const SHARED_CHECK = 'lib/http/sameOrigin.ts';
  const idioms: [string, string, string][] = [
    ['the nextUrl.clone() idiom', 'lib/x.ts', "const u = request.nextUrl.clone(); u.pathname = '/login'; return NextResponse.redirect(u);"],
    ['a request under another name (r.url)', 'lib/x.ts', "return new URL('/login', r.url);"],
    ['a request under another name (nextRequest.url)', 'lib/x.ts', "return new URL('/login', nextRequest.url);"],
    ['a destructured url', 'lib/x.ts', "const { url } = request; return new URL('/login', url);"],
    ['a destructured url with no base to give it away', 'lib/x.ts', 'const { url } = request; return new URL(url).origin;'],
    ['code after // inside a string', 'lib/x.ts', "const s = 'a //b'; return new URL('/login', req.url);"],
    ['the Origin of a URL made from the request', 'lib/x.ts', 'return new URL(request.url).origin;'],
    ['an X-Forwarded-Host read in the one file allowed a Host read', SHARED_CHECK, "return request.headers.get('x-forwarded-host');"],
  ];

  it.each(idioms)('catches %s', (_name, file, src) => {
    expect(scan(file, src)).not.toEqual([]);
  });

  function sourceFiles(): string[] {
    const found = ['app', 'lib'].flatMap((dir) =>
      (readdirSync(dir, { recursive: true }) as string[])
        .filter((f) => /\.tsx?$/.test(f))
        .map((f) => `${dir}/${f}`),
    );
    return [...found, 'proxy.ts'];
  }

  it('accepts what is fine: paths only, the configured origin, comments, strings', () => {
    const fine = [
      'const { pathname } = request.nextUrl;',
      'const p = request.nextUrl.pathname + request.nextUrl.search;',
      'const q = request.nextUrl.searchParams.get("a");',
      "return new URL(path, publicOrigin());",
      "return new URL('/x', 'https://example.test');",
      'const parsed = new URL(raw);',
      '// NOT req.nextUrl.origin, and not request.url',
      '/* new URL(p, request.url) */',
      'const s = "request.url and nextUrl.origin and headers.get(\'host\')";',
    ];
    for (const src of fine) expect(scan('lib/x.ts', src), src).toEqual([]);
  });

  it('keeps an exception to its count and its label', () => {
    // The shared check may read Host once. A second read, or X-Forwarded-Host, is a new hit.
    expect(scan(SHARED_CHECK, "a.get('host');")).toEqual([]);
    expect(scan(SHARED_CHECK, "a.get('host'); b.get('host');")).toEqual([L.host]);
    expect(scan(SHARED_CHECK, "a.get('host'); b.get('x-forwarded-host');")).toEqual([L.forwardedHost]);
  });

  it('finds every one in app/ and lib/ accounted for', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50);

    const hits = files.flatMap((file) => scan(file, readFileSync(file, 'utf8')).map((h) => `${file}: ${h}`));

    // Build the URL from publicOrigin() (lib/publicOrigin.ts); a relative `new URL(req.url)`
    // read for searchParams, and `nextUrl.pathname`, are fine and do not match.
    expect(hits).toEqual([]);
  });
});
