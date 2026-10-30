import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { NON_ACTION_ROUTES, PENDING_ROUTES, REMOVED_METHODS, ROUTE_ACTIONS } from '../../lib/authz/routeActions';
import { testDb } from '../helpers/db';

/**
 * FR-ACC-01 (SRS line 473): an account is created only through an invitation, and the open sign-up
 * path and the /register page are removed (ruling 10). Nothing reads ALLOW_OPEN_REGISTRATION any
 * more, so setting it opens nothing.
 *
 * app/api/auth/register/route.ts is kept as a 404 for every method, because with the file deleted
 * the NextAuth catch-all app/api/auth/[...nextauth]/route.ts answers the path with 400 (measured
 * against `next start`). The HTTP form of the same check (POST /api/auth/register and GET /register
 * answer 404 with the variable set) is in e2e/acceptances.spec.ts.
 *
 * `git grep` runs with NO_COLOR=1 and no FORCE_COLOR, and escape sequences are stripped.
 */
function git(args: readonly string[]): string {
  const { FORCE_COLOR: _force, ...env } = process.env;
  try {
    return execFileSync('git', args, { encoding: 'utf8', env: { ...env, NO_COLOR: '1' } }).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  } catch (e) {
    if ((e as { status?: number }).status === 1) return '';   // git grep: no match
    throw e;
  }
}

const ROUTE = 'app/api/auth/register/route.ts';
const validBody = (email: string) => JSON.stringify({
  name: 'Open Registration', email, orgName: 'Open Registration Org', password: 'SecurePass123!', termsAccepted: true,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the open sign-up path is removed (FR-ACC-01)', () => {
  it('FR-ACC-01: with ALLOW_OPEN_REGISTRATION=true, POST /api/auth/register answers 404 and creates no user', async () => {
    vi.stubEnv('ALLOW_OPEN_REGISTRATION', 'true');
    const route = await import('@/app/api/auth/register/route');
    const email = 'open-registration-removed@fixture.test';
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await route[method](new NextRequest('http://localhost/api/auth/register', {
        method, headers: { 'content-type': 'application/json' }, body: validBody(email),
      }));
      expect([res.status, await res.json()], method).toEqual([404, { error: 'Not found', code: 'not_found' }]);
    }
    expect((await route.GET()).status).toBe(404);
    expect(await testDb.user.count({ where: { email } })).toBe(0);
    expect(existsSync('app/(public)/register')).toBe(false);
    expect(existsSync('lib/auth/openRegistration.ts')).toBe(false);
    expect(git(['grep', '-n', 'ALLOW_OPEN_REGISTRATION', '--', 'app', 'lib', 'components', 'docker', '.github'])).toBe('');
  });

  it('FR-ACC-01: the removed route reads no setting, no session and no data', () => {
    const imports = [...readFileSync(ROUTE, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(['@/lib/http/sameOrigin', '@/lib/http/toResponse', 'next/server']);
    expect(readFileSync(ROUTE, 'utf8')).not.toMatch(/process\.env|identityDb|preauth|prisma/i);
  });

  it('FR-ACC-01: the e2e server starts with ALLOW_OPEN_REGISTRATION=true, so the HTTP 404 check runs under its Given in CI', () => {
    // C4 SC-4: ci.yml no longer sets the flag, so the Playwright webServer must (e2e/acceptances.spec.ts).
    const env = readFileSync('playwright.config.ts', 'utf8').match(/^\s*env: \{([^}]*)\},\s*$/m)?.[1] ?? '';
    expect(env).toMatch(/\bALLOW_OPEN_REGISTRATION: 'true'/);
  });

  it('FR-ACC-01 NFR-MNT-01: the route tables list it only as a non-action route', () => {
    expect(NON_ACTION_ROUTES).toContain(ROUTE);
    expect([...PENDING_ROUTES, ...Object.keys(ROUTE_ACTIONS), ...Object.keys(REMOVED_METHODS)].filter((f) => f.includes('auth/register'))).toEqual([]);
  });
});
