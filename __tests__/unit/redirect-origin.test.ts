import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { NextRequest } from 'next/server';

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
 * same fails here the day it is written (the first test would never have known it existed).
 */

const requireIdentityForApi = vi.fn();
const findUnique = vi.fn();
const update = vi.fn();

vi.mock('@/lib/auth/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/identity')>()),
  requireIdentityForApi: (...args: unknown[]) => requireIdentityForApi(...args),
}));
vi.mock('@/lib/data/identity', () => ({
  identityDb: { user: { findUnique: (...a: unknown[]) => findUnique(...a), update: (...a: unknown[]) => update(...a) } },
}));
vi.mock('@/lib/security-logger', () => ({ logSecurityEvent: vi.fn() }));

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

beforeEach(() => {
  requireIdentityForApi.mockReset();
  findUnique.mockReset();
  update.mockReset();
  requireIdentityForApi.mockResolvedValue(ADMIN);
  findUnique.mockResolvedValue({ id: 'target-1', role: 'assessor', isActive: true });
  update.mockResolvedValue({});
});

describe('POST /api/admin/users/[id]/role redirects to the public origin', () => {
  it.each(BIND_HOSTS)('every redirect leaves a request whose URL says %s on the public origin', async (base) => {
    const { UnauthenticatedError } = await import('../../lib/auth/identity');

    // [label, arrange, fields, expected path]
    const cases: [string, () => void, Record<string, string>, string][] = [
      ['unauthenticated', () => requireIdentityForApi.mockRejectedValue(new UnauthenticatedError()), { action: 'deactivate' }, '/login'],
      ['not an admin', () => requireIdentityForApi.mockResolvedValue({ userId: 'u', platformRole: 'assessor' }), { action: 'deactivate' }, '/'],
      ['unknown target', () => findUnique.mockResolvedValue(null), { action: 'deactivate' }, '/admin/users'],
      ['own account', () => findUnique.mockResolvedValue({ id: ADMIN.userId, role: 'admin', isActive: true }), { action: 'deactivate' }, '/admin/users?error=self'],
      ['role changed', () => undefined, { role: 'admin' }, '/admin/users'],
      ['deactivated', () => undefined, { action: 'deactivate' }, '/admin/users'],
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
});

/**
 * Comments and string contents are not code: `app/api/v1/orgs/[slug]/members/route.ts` says
 * "NOT req.nextUrl.origin" in a comment, and that is the explanation this guard exists to keep.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\w'"`])\/\/.*$/gm, '$1');
}

/** What a server file may not do: take the host of an absolute URL from the request. */
const FORBIDDEN: [string, RegExp][] = [
  ['new URL(path, request.url): a two-argument URL based on the request', /new URL\(\s*[^,()]+(?:\([^)]*\))?\s*,\s*(?:request|req)\.(?:url|nextUrl)\b/],
  ['nextUrl.origin / host / hostname / href / protocol', /\bnextUrl\.(?:origin|host|hostname|href|protocol)\b/],
  ['NextResponse.redirect(request.nextUrl ...) / (request.url)', /NextResponse\.redirect\(\s*(?:request|req)\.(?:nextUrl|url)\b/],
  ["a Host or X-Forwarded-Host header read", /\.get\(\s*['"](?:host|x-forwarded-host)['"]\s*\)/i],
];

/**
 * Read for comparison, never to build a URL. The role route's CSRF check compares the Origin
 * header's host with the Host header nginx forwards (`proxy_set_header Host $host`), which is
 * the public name. The bind address does not enter it.
 */
const ALLOWED: Record<string, string[]> = {
  'app/api/admin/users/[id]/role/route.ts': ['a Host or X-Forwarded-Host header read'],
};

describe('no server file builds an absolute URL from the request', () => {
  function sourceFiles(): string[] {
    const found = ['app', 'lib'].flatMap((dir) =>
      (readdirSync(dir, { recursive: true }) as string[])
        .filter((f) => /\.tsx?$/.test(f))
        .map((f) => `${dir}/${f}`),
    );
    return [...found, 'proxy.ts'];
  }

  it('matches the patterns it is meant to forbid, so a silent regex cannot pass the scan', () => {
    const bad = [
      "NextResponse.redirect(new URL('/login', request.url), 303)",
      "new URL('/admin/users', req.url)",
      'const o = req.nextUrl.origin;',
      "request.headers.get('host')",
    ];
    for (const line of bad) {
      expect(FORBIDDEN.some(([, re]) => re.test(line)), line).toBe(true);
    }
    const fine = ['const { searchParams } = new URL(req.url);', 'const { pathname } = request.nextUrl;'];
    for (const line of fine) {
      expect(FORBIDDEN.some(([, re]) => re.test(line)), line).toBe(false);
    }
  });

  it('finds every one in app/ and lib/ accounted for', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50);

    const hits: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const [label, re] of FORBIDDEN) {
        if (re.test(code) && !(ALLOWED[file] ?? []).includes(label)) hits.push(`${file}: ${label}`);
      }
    }

    // Build the URL from publicOrigin() (lib/publicOrigin.ts); a relative `new URL(req.url)`
    // read for searchParams, and `nextUrl.pathname`, are fine and do not match.
    expect(hits).toEqual([]);
  });
});
